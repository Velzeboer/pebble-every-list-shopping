/*
 * Standalone AnyList client for PebbleKit JS.
 *
 * Runs entirely on the phone (no proxy server). It:
 *   1. Logs into AnyList (email/password -> access/refresh tokens).
 *   2. Fetches the protobuf user-data, parses just the fields we need, and
 *      groups the chosen list by category in AnyList's order.
 *   3. Encodes a check-off operation and posts it back to AnyList.
 *
 * Tokens and a generated client id are cached in localStorage so we don't log
 * in on every launch. The AnyList API is unofficial/reverse-engineered.
 */

var pb = require('./pb');

var BASE = 'https://www.anylist.com/';
var UNCATEGORIZED = 'Uncategorized';

// localStorage keys
var K_ACCESS = 'al_access';
var K_REFRESH = 'al_refresh';
var K_CLIENT = 'al_clientid';

function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

function getClientId() {
  var id = lsGet(K_CLIENT);
  if (!id) { id = pb.uuidv4(); lsSet(K_CLIENT, id); }
  return id;
}

// Build a simple multipart/form-data body (text fields only) and return
// { body, contentType }.
function multipartText(fields) {
  var boundary = '----anylist' + Date.now() + Math.floor(Math.random() * 1e6);
  var s = '';
  for (var name in fields) {
    if (!fields.hasOwnProperty(name)) continue;
    s += '--' + boundary + '\r\n';
    s += 'Content-Disposition: form-data; name="' + name + '"\r\n\r\n';
    s += fields[name] + '\r\n';
  }
  s += '--' + boundary + '--\r\n';
  return { body: s, contentType: 'multipart/form-data; boundary=' + boundary };
}

// Build a multipart body whose single field carries binary bytes.
function multipartBinary(name, bytes) {
  var boundary = '----anylist' + Date.now() + Math.floor(Math.random() * 1e6);
  var pre = '--' + boundary + '\r\n' +
    'Content-Disposition: form-data; name="' + name + '"\r\n' +
    'Content-Type: application/octet-stream\r\n\r\n';
  var post = '\r\n--' + boundary + '--\r\n';
  var body = pb.concatBytes([pb.asciiToBytes(pre), bytes, pb.asciiToBytes(post)]);
  return { body: body.buffer, contentType: 'multipart/form-data; boundary=' + boundary };
}

// ---------------------------------------------------------------------------
function AnyListClient(email, password) {
  this.email = email;
  this.password = password;
  this.clientId = getClientId();
  this.accessToken = lsGet(K_ACCESS);
  this.refreshToken = lsGet(K_REFRESH);
  this.meta = { userId: null, listIdByItem: {} };
}

AnyListClient.prototype._saveTokens = function (access, refresh) {
  this.accessToken = access;
  this.refreshToken = refresh;
  lsSet(K_ACCESS, access);
  lsSet(K_REFRESH, refresh);
};

AnyListClient.prototype._login = function (cb) {
  var self = this;
  var mp = multipartText({ email: this.email, password: this.password });
  var xhr = new XMLHttpRequest();
  xhr.open('POST', BASE + 'auth/token', true);
  xhr.timeout = 20000;
  xhr.setRequestHeader('X-AnyLeaf-API-Version', '3');
  xhr.setRequestHeader('Content-Type', mp.contentType);
  xhr.onload = function () {
    if (xhr.status < 200 || xhr.status >= 300) { cb('Login failed (' + xhr.status + ')'); return; }
    try {
      var j = JSON.parse(xhr.responseText);
      self._saveTokens(j.access_token, j.refresh_token);
      cb(null);
    } catch (e) { cb('Login parse error'); }
  };
  xhr.onerror = function () { cb('Cannot reach AnyList'); };
  xhr.ontimeout = function () { cb('Login timed out'); };
  xhr.send(mp.body);
};

AnyListClient.prototype._refresh = function (cb) {
  if (!this.refreshToken) { this._login(cb); return; }
  var self = this;
  var mp = multipartText({ refresh_token: this.refreshToken });
  var xhr = new XMLHttpRequest();
  xhr.open('POST', BASE + 'auth/token/refresh', true);
  xhr.timeout = 20000;
  xhr.setRequestHeader('X-AnyLeaf-API-Version', '3');
  xhr.setRequestHeader('Content-Type', mp.contentType);
  xhr.onload = function () {
    if (xhr.status < 200 || xhr.status >= 300) { self._login(cb); return; }
    try {
      var j = JSON.parse(xhr.responseText);
      self._saveTokens(j.access_token, j.refresh_token);
      cb(null);
    } catch (e) { self._login(cb); }
  };
  xhr.onerror = function () { self._login(cb); };
  xhr.ontimeout = function () { self._login(cb); };
  xhr.send(mp.body);
};

AnyListClient.prototype._ensureAuth = function (cb) {
  if (this.accessToken) { cb(null); return; }
  this._login(cb);
};

// POST to a /data/ endpoint. body may be null, a string, or an ArrayBuffer.
// Returns a Uint8Array of the (protobuf) response.
AnyListClient.prototype._dataPost = function (path, body, contentType, cb, _retried) {
  var self = this;
  this._ensureAuth(function (err) {
    if (err) { cb(err); return; }
    var xhr = new XMLHttpRequest();
    xhr.open('POST', BASE + path, true);
    xhr.timeout = 25000;
    xhr.responseType = 'arraybuffer';
    xhr.setRequestHeader('X-AnyLeaf-API-Version', '3');
    xhr.setRequestHeader('X-AnyLeaf-Client-Identifier', self.clientId);
    xhr.setRequestHeader('Authorization', 'Bearer ' + self.accessToken);
    if (contentType) xhr.setRequestHeader('Content-Type', contentType);
    xhr.onload = function () {
      if (xhr.status === 401 && !_retried) {
        self._refresh(function (rerr) {
          if (rerr) { cb(rerr); return; }
          self._dataPost(path, body, contentType, cb, true);
        });
        return;
      }
      if (xhr.status < 200 || xhr.status >= 300) { cb('AnyList error (' + xhr.status + ')'); return; }
      try {
        cb(null, new Uint8Array(xhr.response));
      } catch (e) { cb('Bad response'); }
    };
    xhr.onerror = function () { cb('Cannot reach AnyList'); };
    xhr.ontimeout = function () { cb('AnyList timed out'); };
    xhr.send(body == null ? null : body);
  });
};

// ---------------------------------------------------------------------------
// Parsing (field numbers come from AnyList's protobuf definitions)
// ---------------------------------------------------------------------------
// PBItemQuantity { amount=1, unit=2, rawQuantity=3 }. "400 g" is stored as
// amount="400", unit="g" (and usually rawQuantity="400 g"), so combine them.
function parseQuantity(bytes) {
  var amount = '', unit = '', raw = '';
  pb.eachField(bytes, function (f, v, wt) {
    if (wt !== 2) return;
    if (f === 1) amount = pb.utf8ToStr(v);
    else if (f === 2) unit = pb.utf8ToStr(v);
    else if (f === 3) raw = pb.utf8ToStr(v);
  });
  if (raw) return raw;
  if (amount && unit) return amount + ' ' + unit;
  return amount || unit || '';
}

// Quantity carried by a recipe ingredient: PBItemIngredient { ingredient=1
// (PBIngredient { quantity=3 }), quantityPb=6 (PBItemQuantity) }.
function parseIngredientQuantity(bytes) {
  var fromPb = '', fromIng = '';
  pb.eachField(bytes, function (f, v, wt) {
    if (wt !== 2) return;
    if (f === 6) fromPb = parseQuantity(v);
    else if (f === 1) {
      pb.eachField(v, function (ff, vv, ww) {
        if (ff === 3 && ww === 2) fromIng = pb.utf8ToStr(vv); // PBIngredient.quantity
      });
    }
  });
  return fromPb || fromIng || '';
}

function parseCategoryAssignment(bytes) {
  var a = { categoryGroupId: '', categoryId: '' };
  pb.eachField(bytes, function (f, v, wt) {
    if (wt !== 2) return;
    if (f === 2) a.categoryGroupId = pb.utf8ToStr(v);
    else if (f === 3) a.categoryId = pb.utf8ToStr(v);
  });
  return a;
}

function parseItem(bytes) {
  var it = { identifier: '', name: '', checked: false, category: '', categoryMatchId: '', manualSortIndex: 0, quantity: '', ingredientQuantity: '', categoryAssignments: [] };
  pb.eachField(bytes, function (f, v, wt) {
    if (wt === 2) {
      if (f === 1) it.identifier = pb.utf8ToStr(v);
      else if (f === 4) it.name = pb.utf8ToStr(v);
      else if (f === 11) it.category = pb.utf8ToStr(v);
      else if (f === 13) it.categoryMatchId = pb.utf8ToStr(v);
      else if (f === 20) it.categoryAssignments.push(parseCategoryAssignment(v));
      else if (f === 18) { var dq = pb.utf8ToStr(v); if (!it.quantity) it.quantity = dq; } // legacy quantity
      else if (f === 21) it.quantity = parseQuantity(v); // preferred quantity (overrides legacy)
      else if (f === 27) { if (!it.ingredientQuantity) { var iq = parseIngredientQuantity(v); if (iq) it.ingredientQuantity = iq; } } // recipe ingredient
    } else if (wt === 0) {
      if (f === 6) it.checked = !!v;
      else if (f === 17) it.manualSortIndex = v;
    }
  });
  // Items added from a recipe carry their quantity on the ingredient, not on
  // the item itself; fall back to it when the item has no quantity of its own.
  if (!it.quantity && it.ingredientQuantity) it.quantity = it.ingredientQuantity;
  return it;
}

function parseShoppingList(bytes) {
  var list = { identifier: '', name: '', items: [] };
  pb.eachField(bytes, function (f, v, wt) {
    if (wt !== 2) return;
    if (f === 1) list.identifier = pb.utf8ToStr(v);
    else if (f === 3) list.name = pb.utf8ToStr(v);
    else if (f === 4) list.items.push(parseItem(v));
  });
  return list;
}

function parseCategory(bytes) {
  var c = { identifier: '', name: '', sortIndex: 0 };
  pb.eachField(bytes, function (f, v, wt) {
    if (wt === 2) {
      if (f === 1) c.identifier = pb.utf8ToStr(v);
      else if (f === 5) c.name = pb.utf8ToStr(v);
    } else if (wt === 0 && f === 9) {
      c.sortIndex = v;
    }
  });
  return c;
}

function parseCategoryGroup(bytes) {
  var g = { identifier: '', categories: [] };
  pb.eachField(bytes, function (f, v, wt) {
    if (wt !== 2) return;
    if (f === 1) g.identifier = pb.utf8ToStr(v);
    else if (f === 5) g.categories.push(parseCategory(v));
  });
  return g;
}

function parseListResponse(bytes) {
  var r = { listId: '', categoryGroups: [] };
  pb.eachField(bytes, function (f, v, wt) {
    if (wt !== 2) return;
    if (f === 1) r.listId = pb.utf8ToStr(v);
    else if (f === 7) {
      // PBListCategoryGroupResponse { categoryGroup = 1 }
      pb.eachField(v, function (ff, vv, ww) {
        if (ff === 1 && ww === 2) r.categoryGroups.push(parseCategoryGroup(vv));
      });
    }
  });
  return r;
}

function parseCategoryOrdering(bytes) {
  var o = { identifier: '', categories: [] };
  pb.eachField(bytes, function (f, v, wt) {
    if (wt !== 2) return;
    if (f === 1) o.identifier = pb.utf8ToStr(v);
    else if (f === 3) o.categories.push(pb.utf8ToStr(v));
  });
  return o;
}

function parseListSettings(bytes) {
  var s = { listId: '', userId: '', selectedCategoryOrdering: '', listCategoryGroupId: '', categoryOrderings: [], iconName: '', tintHexColor: '' };
  pb.eachField(bytes, function (f, v, wt) {
    if (wt !== 2) return;
    if (f === 3) s.listId = pb.utf8ToStr(v);
    else if (f === 2) s.userId = pb.utf8ToStr(v);
    else if (f === 6) s.selectedCategoryOrdering = pb.utf8ToStr(v);
    else if (f === 27) s.listCategoryGroupId = pb.utf8ToStr(v);
    else if (f === 7) s.categoryOrderings.push(parseCategoryOrdering(v));
    else if (f === 32) { // PBIcon { iconName=1, tintHexColor=2 }
      pb.eachField(v, function (ff, vv, ww) {
        if (ww !== 2) return;
        if (ff === 1) s.iconName = pb.utf8ToStr(vv);
        else if (ff === 2) s.tintHexColor = pb.utf8ToStr(vv);
      });
    }
  });
  return s;
}

function parseUserData(bytes) {
  var data = { lists: [], listResponses: [], settings: [] };
  pb.eachField(bytes, function (f, v, wt) {
    if (wt !== 2) return;
    if (f === 1) {
      // ShoppingListsResponse { newLists=1, listResponses=6 }
      pb.eachField(v, function (ff, vv, ww) {
        if (ww !== 2) return;
        if (ff === 1) data.lists.push(parseShoppingList(vv));
        else if (ff === 6) data.listResponses.push(parseListResponse(vv));
      });
    } else if (f === 9) {
      // PBListSettingsList { settings=2 }
      pb.eachField(v, function (ff, vv, ww) {
        if (ff === 2 && ww === 2) data.settings.push(parseListSettings(vv));
      });
    }
  });
  return data;
}

// ---------------------------------------------------------------------------
// Categorization (same logic as the original proxy)
// ---------------------------------------------------------------------------
function categorize(data, listName, showChecked, meta) {
  var lists = data.lists;
  if (!lists.length) return { error: 'No lists found' };
  var list = listName ? null : lists[0];
  if (listName) {
    for (var i = 0; i < lists.length; i++) if (lists[i].name === listName) { list = lists[i]; break; }
  }
  if (!list) return { error: 'List "' + listName + '" not found' };

  var settings = null;
  for (var s = 0; s < data.settings.length; s++) if (data.settings[s].listId === list.identifier) { settings = data.settings[s]; break; }
  var groupId = settings && settings.listCategoryGroupId;
  if (meta) meta.userId = (settings && settings.userId) || null;

  // Pick the category group for this list.
  var group = null;
  for (var r = 0; r < data.listResponses.length; r++) {
    var lr = data.listResponses[r];
    if (lr.listId && lr.listId !== list.identifier) continue;
    for (var g = 0; g < lr.categoryGroups.length; g++) {
      var cg = lr.categoryGroups[g];
      if (groupId && cg.identifier === groupId) group = cg;
      else if (!group) group = cg;
    }
  }

  var byId = {};
  var cats = (group && group.categories) || [];
  for (var c = 0; c < cats.length; c++) byId[cats[c].identifier] = { name: cats[c].name || UNCATEGORIZED, sortIndex: cats[c].sortIndex || 0 };

  var order = cats.slice().sort(function (a, b) { return (a.sortIndex || 0) - (b.sortIndex || 0); }).map(function (x) { return x.identifier; });
  if (settings && settings.selectedCategoryOrdering && settings.categoryOrderings.length) {
    for (var o = 0; o < settings.categoryOrderings.length; o++) {
      if (settings.categoryOrderings[o].identifier === settings.selectedCategoryOrdering && settings.categoryOrderings[o].categories.length) {
        order = settings.categoryOrderings[o].categories.slice();
      }
    }
  }
  var rankById = {};
  for (var k = 0; k < order.length; k++) rankById[order[k]] = k;

  function resolve(it) {
    var catId = null;
    if (it.categoryAssignments.length) {
      var match = null;
      if (groupId) for (var a = 0; a < it.categoryAssignments.length; a++) if (it.categoryAssignments[a].categoryGroupId === groupId) { match = it.categoryAssignments[a]; break; }
      var chosen = match || it.categoryAssignments[0];
      if (chosen && chosen.categoryId) catId = chosen.categoryId;
    }
    if (!catId && it.categoryMatchId) catId = it.categoryMatchId;
    if (catId && byId[catId]) return { name: byId[catId].name, rank: (rankById[catId] != null ? rankById[catId] : 9000) };
    if (it.category && it.category.length) return { name: it.category, rank: 9000 };
    return { name: UNCATEGORIZED, rank: 10000 };
  }

  var buckets = {}; // name -> {rank, items}
  for (var n = 0; n < list.items.length; n++) {
    var item = list.items[n];
    if (!showChecked && item.checked) continue;
    if (meta) meta.listIdByItem[item.identifier] = list.identifier;
    var res = resolve(item);
    if (!buckets[res.name]) buckets[res.name] = { rank: res.rank, items: [] };
    if (res.rank < buckets[res.name].rank) buckets[res.name].rank = res.rank;
    buckets[res.name].items.push(item);
  }

  var names = [];
  for (var nm in buckets) if (buckets.hasOwnProperty(nm)) names.push(nm);
  names.sort(function (a, b) { return buckets[a].rank - buckets[b].rank || (a < b ? -1 : a > b ? 1 : 0); });

  var categories = names.map(function (name) {
    var its = buckets[name].items.slice().sort(function (x, y) {
      if (x.manualSortIndex !== y.manualSortIndex) return x.manualSortIndex - y.manualSortIndex;
      return (x.name < y.name ? -1 : x.name > y.name ? 1 : 0);
    }).map(function (it) {
      return { id: it.identifier, name: it.name, quantity: it.quantity || '', checked: !!it.checked };
    });
    return { name: name, items: its };
  });

  return { list: list.name, listId: list.identifier, categories: categories };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
// Return every list on the account: [{ id, name, icon, color }].
AnyListClient.prototype.getAllLists = function (cb) {
  this._dataPost('data/user-data/get', null, null, function (err, bytes) {
    if (err) { cb(err); return; }
    var data;
    try { data = parseUserData(bytes); } catch (e) { cb('Could not read AnyList data'); return; }
    var out = [];
    for (var i = 0; i < data.lists.length; i++) {
      var l = data.lists[i];
      var s = null;
      for (var j = 0; j < data.settings.length; j++) {
        if (data.settings[j].listId === l.identifier) { s = data.settings[j]; break; }
      }
      out.push({
        id: l.identifier,
        name: l.name || '',
        icon: (s && s.iconName) || '',
        color: (s && s.tintHexColor) || ''
      });
    }
    cb(null, out);
  });
};

AnyListClient.prototype.getCategorizedList = function (listName, showChecked, cb) {
  var self = this;
  this._dataPost('data/user-data/get', null, null, function (err, bytes) {
    if (err) { cb(err); return; }
    var data;
    try {
      data = parseUserData(bytes);
    } catch (e) { cb('Could not read AnyList data'); return; }
    self.meta = { userId: null, listIdByItem: {} };
    var result = categorize(data, listName, showChecked, self.meta);
    if (result.error) { cb(result.error); return; }
    cb(null, result);
  });
};

// Encode a single "set checked" PBListOperationList -> Uint8Array.
function encodeCheckOp(listId, itemId, checked, userId) {
  var meta = new pb.Writer();
  meta.string(1, pb.uuidv4());               // operationId
  meta.string(2, 'set-list-item-checked');   // handlerId
  if (userId) meta.string(3, userId);        // userId (optional)

  var op = new pb.Writer();
  op.message(1, meta.finish());      // metadata
  op.string(2, listId);              // listId
  op.string(3, itemId);              // listItemId
  op.string(4, checked ? 'y' : 'n'); // updatedValue

  var opList = new pb.Writer();
  opList.message(1, op.finish());    // operations[0]
  return opList.finish();
}

// Encode a minimal ListItem (enough for a remove operation).
function encodeListItemForRemove(item, listId) {
  var w = new pb.Writer();
  w.string(1, item.identifier);          // identifier
  if (listId) w.string(3, listId);       // listId
  if (item.name) w.string(4, item.name); // name
  w.varint(6, item.checked ? 1 : 0);     // checked
  return w.finish();
}

// Encode a PBListOperationList of remove-item operations -> Uint8Array.
function encodeRemoveOps(listId, items, userId) {
  var opList = new pb.Writer();
  for (var i = 0; i < items.length; i++) {
    var meta = new pb.Writer();
    meta.string(1, pb.uuidv4());                  // operationId
    meta.string(2, 'remove-shopping-list-item');  // handlerId
    if (userId) meta.string(3, userId);           // userId (optional)

    var op = new pb.Writer();
    op.message(1, meta.finish());                         // metadata
    op.string(2, listId);                                 // listId
    op.string(3, items[i].identifier);                    // listItemId
    op.message(6, encodeListItemForRemove(items[i], listId)); // listItem

    opList.message(1, op.finish());                       // operations[i]
  }
  return opList.finish();
}

function pickList(data, listName) {
  if (!data.lists.length) return null;
  if (!listName) return data.lists[0];
  for (var i = 0; i < data.lists.length; i++) if (data.lists[i].name === listName) return data.lists[i];
  return null;
}

// Encode a "set checked" operation list and POST it.
AnyListClient.prototype.checkItem = function (itemId, checked, cb) {
  var listId = this.meta.listIdByItem[itemId];
  if (!listId) { cb('Unknown item'); return; }

  var mp = multipartBinary('operations', encodeCheckOp(listId, itemId, checked, this.meta.userId));
  this._dataPost('data/shopping-lists/update', mp.body, mp.contentType, function (err) {
    if (err) { cb(err); return; }
    cb(null);
  });
};

// Remove all checked-off items from the chosen list. Calls back with the
// number removed.
AnyListClient.prototype.removeCheckedItems = function (listName, cb) {
  var self = this;
  this._dataPost('data/user-data/get', null, null, function (err, bytes) {
    if (err) { cb(err); return; }
    var data;
    try { data = parseUserData(bytes); } catch (e) { cb('Could not read AnyList data'); return; }
    var list = pickList(data, listName);
    if (!list) { cb(listName ? ('List "' + listName + '" not found') : 'No lists found'); return; }

    var userId = null;
    for (var s = 0; s < data.settings.length; s++) {
      if (data.settings[s].listId === list.identifier) { userId = data.settings[s].userId || null; break; }
    }

    var checked = [];
    for (var i = 0; i < list.items.length; i++) if (list.items[i].checked) checked.push(list.items[i]);
    if (!checked.length) { cb(null, 0); return; }

    var mp = multipartBinary('operations', encodeRemoveOps(list.identifier, checked, userId));
    self._dataPost('data/shopping-lists/update', mp.body, mp.contentType, function (e2) {
      if (e2) { cb(e2); return; }
      cb(null, checked.length);
    });
  });
};

// Exported for testing in Node.
AnyListClient._parseUserData = parseUserData;
AnyListClient._categorize = categorize;
AnyListClient._encodeCheckOp = encodeCheckOp;
AnyListClient._encodeRemoveOps = encodeRemoveOps;

module.exports = AnyListClient;
