/*
 * PebbleKit JS — runs on the phone. Standalone: talks to AnyList directly,
 * no proxy server. Credentials come from the Clay settings page.
 */

// Clay is vendored locally (src/pkjs/clay.js) instead of using the pebble-clay
// npm package, because that package doesn't declare support for the flint
// (Pebble 2 Duo) platform and blocks the build. The vendored runtime is
// platform-agnostic (it runs in PebbleKit JS on the phone).
var Clay = require('./clay');
// Config is defined inline (not in a separate config.json) so the cloud build
// can't serve a stale copy of it.
var clayConfig = [
  { type: 'heading', defaultValue: 'AnyList Shopping' },
  { type: 'text', defaultValue: 'Enter your AnyList login. It is stored only on this phone and sent directly to AnyList over HTTPS.' },
  {
    type: 'section',
    items: [
      { type: 'heading', defaultValue: 'Account' },
      { type: 'input', messageKey: 'anylist_email', label: 'AnyList email', attributes: { type: 'email', autocorrect: 'off', autocapitalize: 'none' } },
      { type: 'input', messageKey: 'anylist_password', label: 'AnyList password', attributes: { type: 'password' } }
    ]
  },
  {
    type: 'section',
    items: [
      { type: 'heading', defaultValue: 'List' },
      { type: 'input', messageKey: 'anylist_list', label: 'List name', description: 'Leave blank to use your first list.' },
      { type: 'toggle', messageKey: 'start_on_selection', label: 'Start on list selection', defaultValue: false },
      { type: 'toggle', messageKey: 'hide_checked', label: 'Hide checked off items from the list', defaultValue: false },
      { type: 'toggle', messageKey: 'close_after_delete', label: 'Close after Delete Checked Items', defaultValue: false }
    ]
  },
  { type: 'submit', defaultValue: 'Save' }
];
var clay = new Clay(clayConfig);

var AnyListClient = require('./anylist');

// ---- Protocol command codes (must match main.c) ----
var CMD_LIST_START = 1;
var CMD_ITEM = 2;
var CMD_LIST_END = 3;
var CMD_ERROR = 4;
var CMD_TOGGLE_OK = 5;
var CMD_CLOSE = 6;           // phone -> watch (exit the app)
var CMD_LISTS_START = 7;     // phone -> watch (list overview)
var CMD_LIST_ROW = 8;        // phone -> watch (one list in the overview)
var CMD_LISTS_END = 9;       // phone -> watch
var CMD_REFRESH = 10;        // watch -> phone
var CMD_TOGGLE = 11;         // watch -> phone
var CMD_DELETE_CHECKED = 12; // watch -> phone
var CMD_OPEN_LIST = 13;      // watch -> phone (open list by overview index)

var MAX_NAME = 40;
var MAX_CAT = 26;

var client = null;
var items = []; // [{ id, name, cat, checked }]
var overviewLists = []; // [{ id, name, icon, color }]
var activeListName = null; // list chosen from the overview (overrides the setting)
var sendQueue = [];
var sending = false;

// Parse "#RRGGBB" (or "#AARRGGBB") into 0xRRGGBB, or -1 if none/invalid.
function hexToInt(hex) {
  if (!hex) return -1;
  hex = hex.toString().replace('#', '').trim();
  if (hex.length === 8) hex = hex.substring(2); // drop alpha
  if (hex.length !== 6) return -1;
  var n = parseInt(hex, 16);
  return isNaN(n) ? -1 : n;
}

function truncate(s, n) {
  s = (s == null) ? '' : s.toString();
  return s.length > n ? s.substring(0, n) : s;
}

function getSettings() {
  try { return JSON.parse(localStorage.getItem('clay-settings')) || {}; }
  catch (e) { return {}; }
}

// ---- AppMessage outbox queue (one at a time) ----
function enqueue(msg) { sendQueue.push(msg); pump(); }

function pump() {
  if (sending || sendQueue.length === 0) return;
  sending = true;
  var msg = sendQueue.shift();
  Pebble.sendAppMessage(msg, function () {
    sending = false; pump();
  }, function () {
    setTimeout(function () {
      Pebble.sendAppMessage(msg, function () { sending = false; pump(); },
        function () { sending = false; pump(); });
    }, 250);
  });
}

function sendError(text) { enqueue({ cmd: CMD_ERROR, msg: truncate(text, 60) }); }

var listTitle = 'Shopping';

// Build the flat `items` array from the categorized data (no sending).
function flattenItems(data) {
  items = [];
  listTitle = data.list || 'Shopping';
  var categories = data.categories || [];
  for (var c = 0; c < categories.length; c++) {
    var catName = categories[c].name || 'Other';
    var list = categories[c].items || [];
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      var label = it.name || '';
      if (it.quantity && it.quantity !== '1') label += ' (' + it.quantity + ')';
      items.push({ id: it.id, name: truncate(label, MAX_NAME), cat: truncate(catName, MAX_CAT), checked: it.checked ? 1 : 0 });
    }
  }
}

// Send the current `items` to the watch. `focus` (optional) is the global item
// index to select; -1 = the Delete button; omitted = default (top).
// `showActions` controls whether the watch shows the Delete button (the chk
// flag on LIST_START). `focus` (optional) is the global index to highlight.
function sendList(focus, showActions) {
  enqueue({ cmd: CMD_LIST_START, count: items.length, list: truncate(listTitle, MAX_CAT), chk: showActions === false ? 0 : 1 });
  for (var k = 0; k < items.length; k++) {
    enqueue({ cmd: CMD_ITEM, idx: k, name: items[k].name, cat: items[k].cat, chk: items[k].checked });
  }
  var end = { cmd: CMD_LIST_END };
  if (typeof focus === 'number') end.idx = focus;
  enqueue(end);
}

// Where the highlight should land after a toggle's refresh.
function computeFocus(wasChecked, toggledId, oldIdx, actionsShown) {
  var pos = -1;
  for (var i = 0; i < items.length; i++) { if (items[i].id === toggledId) { pos = i; break; } }
  if (pos >= 0) {
    if (!wasChecked) return pos;            // unchecked -> stay on it
    for (var j = pos + 1; j < items.length; j++) { if (!items[j].checked) return j; } // next unchecked
    if (actionsShown) return -1;            // none left -> Delete button
    return items.length ? items.length - 1 : undefined;
  }
  // Toggled item is gone (checked while "hide checked" is on): focus whatever
  // shifted into its place (the next item), clamped to the list.
  if (items.length === 0) return undefined;
  var t = oldIdx;
  if (t >= items.length) t = items.length - 1;
  if (t < 0) t = 0;
  return t;
}

function ensureClient() {
  var s = getSettings();
  if (!s.anylist_email || !s.anylist_password) return null;
  if (!client) client = new AnyListClient(s.anylist_email, s.anylist_password);
  return client;
}

// The list currently in use: one chosen from the overview, else the setting.
function currentListName() {
  if (activeListName) return activeListName;
  return getSettings().anylist_list || '';
}

function loadAndSend() {
  var s = getSettings();
  var c = ensureClient();
  if (!c) { sendError('Open app settings to add login'); return; }
  var hide = !!s.hide_checked;
  c.getCategorizedList(currentListName(), !hide, function (err, data) {
    if (err) { sendError(err); return; }
    flattenItems(data);
    sendList(undefined, !hide); // default focus (top); Delete button hidden if hiding checked
  });
}

function toggle(idx, checked) {
  if (idx < 0 || idx >= items.length) return;
  var c = ensureClient();
  if (!c) { sendError('Open app settings to add login'); return; }
  var s = getSettings();
  var hide = !!s.hide_checked;
  var toggledId = items[idx].id;
  var oldIdx = idx;
  c.checkItem(toggledId, checked, function (err) {
    if (err) { sendError(err); return; }
    // Re-fetch the list from AnyList, then send it with the right focus.
    c.getCategorizedList(currentListName(), !hide, function (err2, data) {
      if (err2) { sendError(err2); return; }
      flattenItems(data);
      sendList(computeFocus(checked, toggledId, oldIdx, !hide), !hide);
    });
  });
}

function deleteChecked() {
  var s = getSettings();
  var c = ensureClient();
  if (!c) { sendError('Open app settings to add login'); return; }
  var closeAfter = !!s.close_after_delete;
  c.removeCheckedItems(currentListName(), function (err) {
    if (err) { sendError(err); return; }
    if (closeAfter) enqueue({ cmd: CMD_CLOSE }); // items are deleted -> close the app
    else loadAndSend(); // refresh the list after removal
  });
}

// Fetch all lists and send them to the watch as the overview.
function sendOverview() {
  var c = ensureClient();
  if (!c) { sendError('Open app settings to add login'); return; }
  c.getAllLists(function (err, lists) {
    if (err) { sendError(err); return; }
    overviewLists = lists;
    enqueue({ cmd: CMD_LISTS_START, count: lists.length });
    for (var i = 0; i < lists.length; i++) {
      enqueue({ cmd: CMD_LIST_ROW, idx: i, name: truncate(lists[i].name, MAX_NAME), col: hexToInt(lists[i].color) });
    }
    enqueue({ cmd: CMD_LISTS_END });
  });
}

// Open a list chosen from the overview by its index.
function openList(idx) {
  if (idx < 0 || idx >= overviewLists.length) return;
  activeListName = overviewLists[idx].name;
  loadAndSend();
}

// Decide what to show at startup based on the setting.
function boot() {
  if (getSettings().start_on_selection) {
    activeListName = null;
    sendOverview();
  } else {
    activeListName = null;
    loadAndSend();
  }
}

// ---- Pebble events ----
Pebble.addEventListener('ready', function () {
  boot();
});

Pebble.addEventListener('appmessage', function (e) {
  var p = e.payload || {};
  if (p.cmd === CMD_REFRESH) loadAndSend();
  else if (p.cmd === CMD_TOGGLE) toggle(p.idx, p.chk ? true : false);
  else if (p.cmd === CMD_DELETE_CHECKED) deleteChecked();
  else if (p.cmd === CMD_OPEN_LIST) openList(p.idx);
});

// When settings are saved, drop the cached client and re-run the startup flow.
Pebble.addEventListener('webviewclosed', function (e) {
  if (e && e.response) {
    client = null;
    setTimeout(boot, 300);
  }
});
