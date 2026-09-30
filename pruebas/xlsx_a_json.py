"""Convierte BD_Asistencia_CMN2026.xlsx a JSON para las pruebas locales."""
import json, sys, datetime, openpyxl
wb = openpyxl.load_workbook(sys.argv[1])
def v(x):
    if isinstance(x, datetime.datetime): return {"$date": x.isoformat()}
    return x
out = {ws.title: [[v(c) for c in r] for r in ws.iter_rows(values_only=True)] for ws in wb}
json.dump(out, open(sys.argv[2], 'w'), ensure_ascii=False)
