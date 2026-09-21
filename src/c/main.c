#include <pebble.h>

// ---- Protocol command codes (must match src/pkjs/index.js) ----
#define CMD_LIST_START 1
#define CMD_ITEM       2
#define CMD_LIST_END   3
#define CMD_ERROR      4
#define CMD_TOGGLE_OK  5
#define CMD_CLOSE      6   // phone -> watch: exit the app
#define CMD_LISTS_START 7  // phone -> watch: begin list overview
#define CMD_LIST_ROW    8  // phone -> watch: one overview row
#define CMD_LISTS_END   9  // phone -> watch: end list overview
#define CMD_REFRESH    10  // watch -> phone
#define CMD_TOGGLE     11  // watch -> phone
#define CMD_DELETE_CHECKED 12  // watch -> phone
#define CMD_OPEN_LIST  13  // watch -> phone: open list by overview index

#define MAX_ITEMS   256
#define MAX_SECTIONS 48
#define NAME_LEN    44
#define CAT_LEN     28

typedef struct {
  char name[NAME_LEN];
  char cat[CAT_LEN];
  uint8_t checked;
} ShopItem;

static Window *s_window;
static MenuLayer *s_menu_layer;
static TextLayer *s_status_layer;

static ShopItem *s_items = NULL;     // currently displayed list
static int s_item_count = 0;         // items actually stored

// Incoming list is streamed into a separate buffer and swapped in at LIST_END,
// so the current list stays on screen during a refresh (no blanking on toggle).
static ShopItem *s_build = NULL;
static int s_build_expected = 0;
static int s_build_count = 0;

static char s_sec_name[MAX_SECTIONS][CAT_LEN];
static uint16_t s_sec_start[MAX_SECTIONS];
static uint16_t s_sec_count[MAX_SECTIONS];
static int s_sec_total = 0;

static bool s_ready = false;
static bool s_show_actions = true;   // whether to show the Delete button
static char s_title[CAT_LEN] = "Shopping";

// --- List overview (multi-list) ---
typedef struct { char name[NAME_LEN]; uint8_t r, g, b; bool has_color; } ListEntry;
static ListEntry *s_lists = NULL;
static int s_lists_count = 0;
static int s_lists_expected = 0;
static Window *s_overview_window = NULL;
static MenuLayer *s_overview_menu = NULL;
static bool s_overview_active = false;

// ---------------------------------------------------------------------------
// UI state helpers
// ---------------------------------------------------------------------------
static void set_status(const char *text) {
  if (!s_status_layer || !s_menu_layer) return; // list window not loaded (e.g. overview showing)
  text_layer_set_text(s_status_layer, text);
  layer_set_hidden(text_layer_get_layer(s_status_layer), false);
  layer_set_hidden(menu_layer_get_layer(s_menu_layer), true);
}

static void show_menu(void) {
  layer_set_hidden(text_layer_get_layer(s_status_layer), true);
  layer_set_hidden(menu_layer_get_layer(s_menu_layer), false);
}

// Build contiguous category sections from the (already grouped) item list.
static void build_sections(void) {
  s_sec_total = 0;
  for (int i = 0; i < s_item_count; i++) {
    bool new_section = (s_sec_total == 0) ||
                       (strncmp(s_items[i].cat, s_sec_name[s_sec_total - 1], CAT_LEN) != 0);
    if (new_section) {
      if (s_sec_total >= MAX_SECTIONS) break;
      strncpy(s_sec_name[s_sec_total], s_items[i].cat, CAT_LEN - 1);
      s_sec_name[s_sec_total][CAT_LEN - 1] = '\0';
      s_sec_start[s_sec_total] = i;
      s_sec_count[s_sec_total] = 0;
      s_sec_total++;
    }
    s_sec_count[s_sec_total - 1]++;
  }
}

// Convert a global item index into its MenuLayer (section, row) position.
static MenuIndex item_to_menu_index(int g) {
  for (int s = 0; s < s_sec_total; s++) {
    if (g >= s_sec_start[s] && g < s_sec_start[s] + s_sec_count[s]) {
      MenuIndex mi = { .section = (uint16_t)s, .row = (uint16_t)(g - s_sec_start[s]) };
      return mi;
    }
  }
  MenuIndex mi = { .section = 0, .row = 0 };
  return mi;
}

static void free_items(void) {
  if (s_items) { free(s_items); s_items = NULL; }
  if (s_build) { free(s_build); s_build = NULL; }
  s_item_count = 0;
  s_build_expected = 0;
  s_build_count = 0;
  s_sec_total = 0;
}

// ---------------------------------------------------------------------------
// Outbox: ask the phone to do something
// ---------------------------------------------------------------------------
static void send_simple(int cmd) {
  DictionaryIterator *iter;
  if (app_message_outbox_begin(&iter) != APP_MSG_OK) return;
  int c = cmd;
  dict_write_int(iter, MESSAGE_KEY_cmd, &c, sizeof(int), true);
  app_message_outbox_send();
}

static void send_toggle(int idx, int checked) {
  DictionaryIterator *iter;
  if (app_message_outbox_begin(&iter) != APP_MSG_OK) return;
  int c = CMD_TOGGLE, i = idx, ch = checked;
  dict_write_int(iter, MESSAGE_KEY_cmd, &c, sizeof(int), true);
  dict_write_int(iter, MESSAGE_KEY_idx, &i, sizeof(int), true);
  dict_write_int(iter, MESSAGE_KEY_chk, &ch, sizeof(int), true);
  app_message_outbox_send();
}

static void send_open_list(int idx) {
  DictionaryIterator *iter;
  if (app_message_outbox_begin(&iter) != APP_MSG_OK) return;
  int c = CMD_OPEN_LIST, i = idx;
  dict_write_int(iter, MESSAGE_KEY_cmd, &c, sizeof(int), true);
  dict_write_int(iter, MESSAGE_KEY_idx, &i, sizeof(int), true);
  app_message_outbox_send();
}

// ---------------------------------------------------------------------------
// Delete confirmation window (Up = cancel, Down = confirm)
// ---------------------------------------------------------------------------
static Window *s_confirm_window = NULL;
static TextLayer *s_confirm_text = NULL;

static void confirm_up(ClickRecognizerRef recognizer, void *ctx) {
  window_stack_pop(true); // cancel
}

static void confirm_down(ClickRecognizerRef recognizer, void *ctx) {
  window_stack_pop(true); // dismiss confirmation, back to the list
  set_status("Deleting...");
  send_simple(CMD_DELETE_CHECKED);
}

static void confirm_click_config(void *ctx) {
  window_single_click_subscribe(BUTTON_ID_UP, confirm_up);
  window_single_click_subscribe(BUTTON_ID_DOWN, confirm_down);
}

static void confirm_window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect b = layer_get_bounds(root);
  s_confirm_text = text_layer_create(GRect(4, 12, b.size.w - 8, b.size.h - 12));
  text_layer_set_text(s_confirm_text, "Delete checked items?\n\nUP: Cancel\nDOWN: Confirm");
  text_layer_set_text_alignment(s_confirm_text, GTextAlignmentCenter);
  text_layer_set_font(s_confirm_text, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD));
  text_layer_set_background_color(s_confirm_text, GColorClear);
  layer_add_child(root, text_layer_get_layer(s_confirm_text));
}

static void confirm_window_unload(Window *window) {
  text_layer_destroy(s_confirm_text);
  s_confirm_text = NULL;
  window_destroy(s_confirm_window);
  s_confirm_window = NULL;
}

static void show_confirm(void) {
  s_confirm_window = window_create();
  window_set_click_config_provider(s_confirm_window, confirm_click_config);
  window_set_window_handlers(s_confirm_window, (WindowHandlers){
    .load = confirm_window_load,
    .unload = confirm_window_unload,
  });
  window_stack_push(s_confirm_window, true);
}

// ---------------------------------------------------------------------------
// Pulsing red background for the Delete checked items button
// ---------------------------------------------------------------------------
#define PULSE_STEPS 28
#define PULSE_INTERVAL_MS 55
static AppTimer *s_pulse_timer = NULL;
static bool s_pulse_active = false;
static int s_pulse_t = 0;

static GColor delete_bg_color(void) {
#if defined(PBL_COLOR)
  if (s_pulse_active) {
    int half = PULSE_STEPS / 2;
    int t = s_pulse_t % PULSE_STEPS;
    int tri = (t < half) ? t : (PULSE_STEPS - t);  // 0..half..0
    int r = 0x55 + (0xAA * tri) / half;            // 85..255 (gentle pulse)
    return GColorFromRGB(r, 0, 0);
  }
  return GColorRed;
#else
  return GColorBlack;
#endif
}

static void pulse_timer_cb(void *data) {
  s_pulse_t = (s_pulse_t + 1) % PULSE_STEPS;
  if (s_menu_layer) layer_mark_dirty(menu_layer_get_layer(s_menu_layer));
  if (s_pulse_active) {
    s_pulse_timer = app_timer_register(PULSE_INTERVAL_MS, pulse_timer_cb, NULL);
  }
}

static void start_pulse(void) {
  if (s_pulse_active) return;
  s_pulse_active = true;
  s_pulse_t = 0;
  s_pulse_timer = app_timer_register(PULSE_INTERVAL_MS, pulse_timer_cb, NULL);
}

static void stop_pulse(void) {
  if (!s_pulse_active) return;
  s_pulse_active = false;
  if (s_pulse_timer) { app_timer_cancel(s_pulse_timer); s_pulse_timer = NULL; }
  if (s_menu_layer) layer_mark_dirty(menu_layer_get_layer(s_menu_layer));
}

// ---------------------------------------------------------------------------
// Marquee: horizontally scroll a long item name while it is selected
// ---------------------------------------------------------------------------
#define MARQUEE_INTERVAL_MS 60
#define MARQUEE_STEP 2
#define MARQUEE_HOLD 14   // ticks paused at each end (~0.8s)
static AppTimer *s_marquee_timer = NULL;
static bool s_marquee_active = false;
static int s_marquee_x = 0;
static int s_marquee_max = 0;
static int s_marquee_hold = 0;

static GFont item_font(void) { return fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD); }

static int item_avail_width(void) {
  return layer_get_bounds(menu_layer_get_layer(s_menu_layer)).size.w - 8;
}

static void stop_marquee(void) {
  if (s_marquee_timer) { app_timer_cancel(s_marquee_timer); s_marquee_timer = NULL; }
  bool was = s_marquee_active;
  s_marquee_active = false;
  s_marquee_x = 0;
  if (was && s_menu_layer) layer_mark_dirty(menu_layer_get_layer(s_menu_layer));
}

static void marquee_timer_cb(void *data) {
  if (!s_marquee_active) return;
  if (s_marquee_hold > 0) {
    s_marquee_hold--;
  } else if (s_marquee_x < s_marquee_max) {
    s_marquee_x += MARQUEE_STEP;
    if (s_marquee_x >= s_marquee_max) { s_marquee_x = s_marquee_max; s_marquee_hold = MARQUEE_HOLD; }
  } else {
    s_marquee_x = 0;          // snap back to the start
    s_marquee_hold = MARQUEE_HOLD;
  }
  if (s_menu_layer) layer_mark_dirty(menu_layer_get_layer(s_menu_layer));
  s_marquee_timer = app_timer_register(MARQUEE_INTERVAL_MS, marquee_timer_cb, NULL);
}

// Start scrolling if the newly selected item's name is wider than the row.
static void marquee_eval(MenuIndex idx) {
  stop_marquee();
  if (idx.section >= (uint16_t)s_sec_total) return; // header/actions row, not an item
  int g = s_sec_start[idx.section] + idx.row;
  if (g < 0 || g >= s_item_count) return;
  GSize sz = graphics_text_layout_get_content_size(s_items[g].name, item_font(),
               GRect(0, 0, 2000, 1000), GTextOverflowModeWordWrap, GTextAlignmentLeft);
  int avail = item_avail_width();
  if (sz.w > avail) {
    s_marquee_active = true;
    s_marquee_x = 0;
    s_marquee_hold = MARQUEE_HOLD;       // brief pause before it starts moving
    s_marquee_max = sz.w - avail + 4;
    s_marquee_timer = app_timer_register(MARQUEE_INTERVAL_MS, marquee_timer_cb, NULL);
  }
}

// ---------------------------------------------------------------------------
// MenuLayer callbacks
// ---------------------------------------------------------------------------
// A trailing "Actions" section (with the Delete-checked button) is shown
// whenever there are items. Its index is s_sec_total.
static bool has_actions(void) {
  return s_show_actions && s_item_count > 0;
}

static uint16_t menu_num_sections(MenuLayer *ml, void *ctx) {
  return s_sec_total + (has_actions() ? 1 : 0);
}

static uint16_t menu_num_rows(MenuLayer *ml, uint16_t section, void *ctx) {
  if (section == s_sec_total) return has_actions() ? 1 : 0; // actions section
  if (section > s_sec_total) return 0;
  return s_sec_count[section];
}

static int16_t menu_header_height(MenuLayer *ml, uint16_t section, void *ctx) {
  return MENU_CELL_BASIC_HEADER_HEIGHT;
}

static void menu_draw_header(GContext *ctx, const Layer *cell_layer, uint16_t section, void *context) {
  if (section == s_sec_total) {
    // Separator before the Delete button: a dashed line instead of a label.
    GRect b = layer_get_bounds(cell_layer);
    int16_t y = b.size.h / 2;
    int16_t dash = 6, gap = 4, x0 = 4, x_end = b.size.w - 4;
    graphics_context_set_stroke_color(ctx, PBL_IF_COLOR_ELSE(GColorDarkGray, GColorBlack));
    graphics_context_set_stroke_width(ctx, 2);
    for (int16_t x = x0; x < x_end; x += dash + gap) {
      int16_t x2 = (x + dash > x_end) ? x_end : x + dash;
      graphics_draw_line(ctx, GPoint(x, y), GPoint(x2, y));
    }
    graphics_context_set_stroke_width(ctx, 1); // reset so item strikethroughs stay 1px
  } else if (section < s_sec_total) {
    menu_cell_basic_header_draw(ctx, cell_layer, s_sec_name[section]);
  }
}

#define ITEM_ROW_HEIGHT 27

// Compact height for item rows; the actions row is a single-line button.
static int16_t menu_cell_height(MenuLayer *ml, MenuIndex *cell_index, void *ctx) {
  if (cell_index->section == s_sec_total) return 36; // "Delete checked items" row
  return ITEM_ROW_HEIGHT;
}

static void menu_draw_row(GContext *ctx, const Layer *cell_layer, MenuIndex *cell_index, void *context) {
  if (cell_index->section == s_sec_total) {
    GRect b = layer_get_bounds(cell_layer);
    graphics_context_set_fill_color(ctx, delete_bg_color());
    graphics_fill_rect(ctx, b, 0, GCornerNone);
    graphics_context_set_text_color(ctx, GColorWhite);
    graphics_draw_text(ctx, "Delete checked items",
                       fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD),
                       GRect(4, 3, b.size.w - 8, b.size.h - 3),
                       GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
    return;
  }
  if (cell_index->section > s_sec_total) return;
  int idx = s_sec_start[cell_index->section] + cell_index->row;
  if (idx < 0 || idx >= s_item_count) return;

  GRect bounds = layer_get_bounds(cell_layer);
  bool checked = s_items[idx].checked;

  MenuIndex sel = menu_layer_get_selected_index(s_menu_layer);
  bool highlighted = (sel.section == cell_index->section && sel.row == cell_index->row);

  GColor tcol;
  if (highlighted) tcol = PBL_IF_COLOR_ELSE(GColorBlack, GColorWhite);
  else tcol = checked ? PBL_IF_COLOR_ELSE(GColorDarkGray, GColorBlack) : GColorBlack;

  GFont font = item_font();
  int avail_w = bounds.size.w - 8;
  // Measure the FULL text on a single line (wide box -> never wraps), so the
  // row height and padding are identical whether or not the text overflows.
  GSize sz = graphics_text_layout_get_content_size(s_items[idx].name, font,
               GRect(0, 0, 2000, 1000), GTextOverflowModeWordWrap, GTextAlignmentLeft);
  // Centre the text as if in a 30px row, then lift it 2px. Combined with the
  // 3px-shorter (27px) row, this trims 2px of padding above and 1px below.
  int16_t ty = (30 - sz.h) / 2 - 6;
  if (ty < -8) ty = -8;

  bool overflow = sz.w > avail_w;
  bool scrolling = overflow && highlighted && s_marquee_active;

  int16_t text_x = scrolling ? (int16_t)(4 - s_marquee_x) : 4;
  int16_t draw_w = scrolling ? (int16_t)(sz.w + 10) : (int16_t)avail_w;
  GTextOverflowMode mode = scrolling ? GTextOverflowModeWordWrap : GTextOverflowModeTrailingEllipsis;

  graphics_context_set_text_color(ctx, tcol);
  graphics_draw_text(ctx, s_items[idx].name, font, GRect(text_x, ty, draw_w, sz.h),
                     mode, GTextAlignmentLeft, NULL);

  if (checked) {
    // Strikethrough at ~60% down (+ fixed nudge) lands on the middle of letters.
    int16_t line_y = ty + (sz.h * 3) / 5 + 5;
    int16_t lx1 = scrolling ? (int16_t)(text_x + sz.w)
                            : (int16_t)(4 + (overflow ? avail_w : sz.w));
    graphics_context_set_stroke_color(ctx, tcol);
    graphics_draw_line(ctx, GPoint(text_x, line_y), GPoint(lx1, line_y));
  }
}

static void menu_select(MenuLayer *ml, MenuIndex *cell_index, void *context) {
  if (cell_index->section == s_sec_total) {
    show_confirm(); // ask before deleting; actual delete happens on confirm
    return;
  }
  if (cell_index->section > s_sec_total) return;
  int idx = s_sec_start[cell_index->section] + cell_index->row;
  if (idx < 0 || idx >= s_item_count) return;
  int new_state = s_items[idx].checked ? 0 : 1;
  send_toggle(idx, new_state); // phone writes to AnyList, then sends a refreshed list
}

static void menu_select_long(MenuLayer *ml, MenuIndex *cell_index, void *context) {
  set_status("Refreshing...");
  send_simple(CMD_REFRESH);
}

// Pulse the Delete button only while it is the selected row.
static void menu_selection_changed(MenuLayer *ml, MenuIndex new_index, MenuIndex old_index, void *context) {
  if (has_actions() && new_index.section == s_sec_total) start_pulse();
  else stop_pulse();
  marquee_eval(new_index);
}

// ---------------------------------------------------------------------------
// List overview window (shown at startup when "Start on list selection" is on)
// ---------------------------------------------------------------------------
static uint16_t ov_num_sections(MenuLayer *ml, void *ctx) { return 1; }
static uint16_t ov_num_rows(MenuLayer *ml, uint16_t section, void *ctx) { return s_lists_count; }

static int16_t ov_cell_height(MenuLayer *ml, MenuIndex *ci, void *ctx) {
  int16_t h = layer_get_bounds(menu_layer_get_layer(s_overview_menu)).size.h;
  return h / 4; // exactly 4 rows visible at once
}

static GColor ov_list_color(int i) {
  if (i >= 0 && i < s_lists_count && s_lists[i].has_color) {
    return GColorFromRGB(s_lists[i].r, s_lists[i].g, s_lists[i].b);
  }
  return GColorFromRGB(170, 170, 170);
}

// Text colour that contrasts with a highlighted row's (coloured) background.
static GColor ov_contrast(int i) {
  if (i >= 0 && i < s_lists_count && s_lists[i].has_color) {
    int lum = (s_lists[i].r * 299 + s_lists[i].g * 587 + s_lists[i].b * 114) / 1000;
    return (lum > 140) ? GColorBlack : GColorWhite;
  }
  return GColorBlack;
}

static void ov_draw_row(GContext *ctx, const Layer *cell_layer, MenuIndex *ci, void *context) {
  int i = ci->row;
  if (i < 0 || i >= s_lists_count) return;
  GRect b = layer_get_bounds(cell_layer);
  MenuIndex sel = menu_layer_get_selected_index(s_overview_menu);
  bool hl = (sel.row == ci->row);
  GColor listcol = ov_list_color(i);

  // Selected row: background is the list's own colour.
  graphics_context_set_fill_color(ctx, hl ? listcol : GColorWhite);
  graphics_fill_rect(ctx, b, 0, GCornerNone);

  GColor fg = hl ? ov_contrast(i) : GColorBlack;

  // Icon = a filled dot in the list colour (contrast colour when highlighted).
  int16_t cy = b.size.h / 2;
  int16_t dotr = 6;
  graphics_context_set_fill_color(ctx, hl ? fg : listcol);
  graphics_fill_circle(ctx, GPoint(6 + dotr, cy), dotr);

  int16_t tx = 6 + dotr * 2 + 6; // dot + a space, then the name
  GFont f = fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD);
  GSize sz = graphics_text_layout_get_content_size(s_lists[i].name, f, GRect(0, 0, 2000, 1000),
               GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft);
  int16_t ty = (b.size.h - sz.h) / 2 - 4;
  graphics_context_set_text_color(ctx, fg);
  graphics_draw_text(ctx, s_lists[i].name, f, GRect(tx, ty, b.size.w - tx - 4, sz.h),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
}

static void ov_select(MenuLayer *ml, MenuIndex *ci, void *context) {
  int i = ci->row;
  if (i < 0 || i >= s_lists_count) return;
  window_stack_push(s_window, true); // list window (shows Loading) on top of overview
  send_open_list(i);
}

static void overview_window_load(Window *w) {
  Layer *root = window_get_root_layer(w);
  s_overview_menu = menu_layer_create(layer_get_bounds(root));
  menu_layer_set_callbacks(s_overview_menu, NULL, (MenuLayerCallbacks){
    .get_num_sections = ov_num_sections,
    .get_num_rows = ov_num_rows,
    .get_cell_height = ov_cell_height,
    .draw_row = ov_draw_row,
    .select_click = ov_select,
  });
  menu_layer_set_click_config_onto_window(s_overview_menu, w);
  layer_add_child(root, menu_layer_get_layer(s_overview_menu));
  if (s_lists_count > 0) menu_layer_reload_data(s_overview_menu);
}

static void overview_window_unload(Window *w) {
  if (s_overview_menu) { menu_layer_destroy(s_overview_menu); s_overview_menu = NULL; }
}

// Make the overview the root window (replacing the initial loading list window).
static void ensure_overview_shown(void) {
  if (s_overview_active) return;
  if (!s_overview_window) {
    s_overview_window = window_create();
    window_set_window_handlers(s_overview_window, (WindowHandlers){
      .load = overview_window_load,
      .unload = overview_window_unload,
    });
  }
  window_stack_push(s_overview_window, false);
  window_stack_remove(s_window, false); // drop the initial loading list window
  s_overview_active = true;
}

// ---------------------------------------------------------------------------
// Inbox: messages from the phone
// ---------------------------------------------------------------------------
static void inbox_received(DictionaryIterator *iter, void *context) {
  Tuple *cmd_t = dict_find(iter, MESSAGE_KEY_cmd);
  if (!cmd_t) return;
  int cmd = cmd_t->value->int32;

  switch (cmd) {
    case CMD_LIST_START: {
      // Stream into s_build; keep the current list on screen meanwhile.
      if (s_build) { free(s_build); s_build = NULL; }
      Tuple *count_t = dict_find(iter, MESSAGE_KEY_count);
      Tuple *list_t = dict_find(iter, MESSAGE_KEY_list);
      s_build_expected = count_t ? count_t->value->int32 : 0;
      if (s_build_expected > MAX_ITEMS) s_build_expected = MAX_ITEMS;
      s_build_count = 0;
      if (list_t) {
        strncpy(s_title, list_t->value->cstring, CAT_LEN - 1);
        s_title[CAT_LEN - 1] = '\0';
      }
      Tuple *act_t = dict_find(iter, MESSAGE_KEY_chk); // chk on LIST_START = show Delete button
      s_show_actions = act_t ? (act_t->value->int32 != 0) : true;
      if (s_build_expected > 0) {
        s_build = (ShopItem *)malloc(sizeof(ShopItem) * s_build_expected);
        if (!s_build) {
          set_status("Out of memory");
          s_build_expected = 0;
          return;
        }
        memset(s_build, 0, sizeof(ShopItem) * s_build_expected);
      }
      // Only blank to "Loading..." on the very first load (nothing to show yet).
      if (!s_ready || s_item_count == 0) set_status("Loading...");
      break;
    }

    case CMD_ITEM: {
      Tuple *idx_t = dict_find(iter, MESSAGE_KEY_idx);
      Tuple *name_t = dict_find(iter, MESSAGE_KEY_name);
      Tuple *cat_t = dict_find(iter, MESSAGE_KEY_cat);
      Tuple *chk_t = dict_find(iter, MESSAGE_KEY_chk);
      if (!idx_t || !s_build) return;
      int idx = idx_t->value->int32;
      if (idx < 0 || idx >= s_build_expected) return;
      if (name_t) {
        strncpy(s_build[idx].name, name_t->value->cstring, NAME_LEN - 1);
        s_build[idx].name[NAME_LEN - 1] = '\0';
      }
      if (cat_t) {
        strncpy(s_build[idx].cat, cat_t->value->cstring, CAT_LEN - 1);
        s_build[idx].cat[CAT_LEN - 1] = '\0';
      }
      s_build[idx].checked = (chk_t && chk_t->value->int32) ? 1 : 0;
      if (idx + 1 > s_build_count) s_build_count = idx + 1;
      break;
    }

    case CMD_LIST_END: {
      // Swap the freshly received list in.
      stop_marquee();
      if (s_items) free(s_items);
      s_items = s_build;
      s_item_count = s_build_count;
      s_build = NULL;
      s_build_expected = 0;
      s_build_count = 0;

      if (s_item_count == 0) {
        s_sec_total = 0;
        set_status("List is empty");
        s_ready = true;
        break;
      }
      build_sections();
      s_ready = true;
      show_menu();
      menu_layer_reload_data(s_menu_layer);

      // Optional focus target: >=0 select that item, -1 select Delete button,
      // absent = top (manual refresh / first load).
      Tuple *focus_t = dict_find(iter, MESSAGE_KEY_idx);
      if (focus_t) {
        int focus = focus_t->value->int32;
        if (focus == -1 && has_actions()) {
          MenuIndex mi = { .section = (uint16_t)s_sec_total, .row = 0 };
          menu_layer_set_selected_index(s_menu_layer, mi, MenuRowAlignCenter, false);
        } else if (focus >= 0 && focus < s_item_count) {
          menu_layer_set_selected_index(s_menu_layer, item_to_menu_index(focus), MenuRowAlignCenter, false);
        } else {
          menu_layer_set_selected_index(s_menu_layer, (MenuIndex){0, 0}, MenuRowAlignNone, false);
        }
      } else {
        // First item, not top-aligned, so the first category header stays visible.
        menu_layer_set_selected_index(s_menu_layer, (MenuIndex){0, 0}, MenuRowAlignNone, false);
      }
      break;
    }

    case CMD_CLOSE: {
      // "Close after Delete Checked Items" is on and the delete succeeded.
      window_stack_pop_all(true);
      break;
    }

    case CMD_LISTS_START: {
      if (s_lists) { free(s_lists); s_lists = NULL; }
      Tuple *count_t = dict_find(iter, MESSAGE_KEY_count);
      s_lists_expected = count_t ? count_t->value->int32 : 0;
      if (s_lists_expected > MAX_ITEMS) s_lists_expected = MAX_ITEMS;
      s_lists_count = 0;
      if (s_lists_expected > 0) {
        s_lists = (ListEntry *)malloc(sizeof(ListEntry) * s_lists_expected);
        if (!s_lists) s_lists_expected = 0;
        else memset(s_lists, 0, sizeof(ListEntry) * s_lists_expected);
      }
      ensure_overview_shown();
      break;
    }

    case CMD_LIST_ROW: {
      Tuple *idx_t = dict_find(iter, MESSAGE_KEY_idx);
      Tuple *name_t = dict_find(iter, MESSAGE_KEY_name);
      Tuple *col_t = dict_find(iter, MESSAGE_KEY_col);
      if (!idx_t || !s_lists) return;
      int i = idx_t->value->int32;
      if (i < 0 || i >= s_lists_expected) return;
      if (name_t) {
        strncpy(s_lists[i].name, name_t->value->cstring, NAME_LEN - 1);
        s_lists[i].name[NAME_LEN - 1] = '\0';
      }
      int col = col_t ? col_t->value->int32 : -1;
      if (col >= 0) {
        s_lists[i].r = (col >> 16) & 0xFF;
        s_lists[i].g = (col >> 8) & 0xFF;
        s_lists[i].b = col & 0xFF;
        s_lists[i].has_color = true;
      } else {
        s_lists[i].has_color = false;
      }
      if (i + 1 > s_lists_count) s_lists_count = i + 1;
      break;
    }

    case CMD_LISTS_END: {
      if (s_overview_menu) menu_layer_reload_data(s_overview_menu);
      break;
    }

    case CMD_ERROR: {
      Tuple *msg_t = dict_find(iter, MESSAGE_KEY_msg);
      static char err[64];
      snprintf(err, sizeof(err), "%s", msg_t ? msg_t->value->cstring : "Error");
      set_status(err);
      break;
    }
  }
}

static void inbox_dropped(AppMessageResult reason, void *context) {
  APP_LOG(APP_LOG_LEVEL_WARNING, "Inbox dropped: %d", (int)reason);
}

// ---------------------------------------------------------------------------
// Window lifecycle
// ---------------------------------------------------------------------------
static void window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root);

  s_menu_layer = menu_layer_create(bounds);
  menu_layer_set_callbacks(s_menu_layer, NULL, (MenuLayerCallbacks){
    .get_num_sections = menu_num_sections,
    .get_num_rows = menu_num_rows,
    .get_header_height = menu_header_height,
    .get_cell_height = menu_cell_height,
    .draw_header = menu_draw_header,
    .draw_row = menu_draw_row,
    .select_click = menu_select,
    .select_long_click = menu_select_long,
    .selection_changed = menu_selection_changed,
  });
  menu_layer_set_click_config_onto_window(s_menu_layer, window);
#if defined(PBL_COLOR)
  menu_layer_set_normal_colors(s_menu_layer, GColorWhite, GColorBlack);
  menu_layer_set_highlight_colors(s_menu_layer, GColorGreen, GColorBlack);
#endif
  layer_add_child(root, menu_layer_get_layer(s_menu_layer));

  GRect status_frame = GRect(0, (bounds.size.h / 2) - 20, bounds.size.w, 40);
  s_status_layer = text_layer_create(status_frame);
  text_layer_set_text_alignment(s_status_layer, GTextAlignmentCenter);
  text_layer_set_font(s_status_layer, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD));
  text_layer_set_background_color(s_status_layer, GColorClear);
  layer_add_child(root, text_layer_get_layer(s_status_layer));

  set_status("Loading...");
}

static void window_unload(Window *window) {
  stop_pulse();
  stop_marquee();
  if (s_menu_layer) { menu_layer_destroy(s_menu_layer); s_menu_layer = NULL; }
  if (s_status_layer) { text_layer_destroy(s_status_layer); s_status_layer = NULL; }
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
static void init(void) {
  s_window = window_create();
  window_set_window_handlers(s_window, (WindowHandlers){
    .load = window_load,
    .unload = window_unload,
  });

  app_message_register_inbox_received(inbox_received);
  app_message_register_inbox_dropped(inbox_dropped);
  app_message_open(512, 128);

  window_stack_push(s_window, true);
}

static void deinit(void) {
  stop_pulse();
  stop_marquee();
  free_items();
  if (s_lists) { free(s_lists); s_lists = NULL; }
  window_destroy(s_window);
  if (s_overview_window) window_destroy(s_overview_window);
}

int main(void) {
  init();
  app_event_loop();
  deinit();
}
