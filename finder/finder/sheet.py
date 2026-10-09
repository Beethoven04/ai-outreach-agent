"""Google Sheet access through a service account (see docs/04_google_service_account.md).

Columns are always addressed by header name, never by position (same rule as the n8n workflows).
"""
import gspread

from . import config

_gc = None


def client():
    global _gc
    if _gc is None:
        _gc = gspread.service_account(filename=config.SERVICE_ACCOUNT)
    return _gc


def book():
    if not config.SHEET_ID:
        raise SystemExit("SHEET_ID missing in finder/.env")
    return client().open_by_key(config.SHEET_ID)


def rows(tab: str):
    """List of dicts (header -> value), plus the header list."""
    ws = book().worksheet(tab)
    values = ws.get_all_values()
    if not values:
        return [], []
    hdr = values[0]
    return [dict(zip(hdr, r + [""] * (len(hdr) - len(r)))) for r in values[1:]], hdr


def append(tab: str, records):
    """Append dicts; unknown keys are ignored, missing ones left blank."""
    if not records:
        return 0
    ws = book().worksheet(tab)
    hdr = ws.row_values(1)
    ws.append_rows([[str(rec.get(h, "")) for h in hdr] for rec in records], value_input_option="USER_ENTERED")
    return len(records)


def update_by_key(tab: str, key_col: str, updates: dict):
    """updates: {key_value: {column: value}}. One batch request."""
    ws = book().worksheet(tab)
    values = ws.get_all_values()
    hdr = values[0]
    kidx = hdr.index(key_col)
    cells = []
    for i, r in enumerate(values[1:], start=2):
        k = r[kidx] if kidx < len(r) else ""
        if k in updates:
            for col, val in updates[k].items():
                if col in hdr:
                    cells.append(gspread.Cell(i, hdr.index(col) + 1, str(val)))
    if cells:
        ws.update_cells(cells, value_input_option="USER_ENTERED")
    return len(cells)


def check():
    b = book()
    for ws in b.worksheets():
        print(f"{ws.title:12} rows={ws.row_count:5} cols={ws.col_count}")
