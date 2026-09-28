"""Worker <-> backend version-skew check, WORKER half. Driven by
check-worker-backend-compat.sh; not part of any default suite.

  run    <ctm-core dir> <responses.json> <captured.json>
      Runs THAT worker version's real process_station() + build_run_record()
      against one backend version's captured spike-check responses (HTTP
      mocked) and records exactly what it would POST.
  verify <label> <captured.json> <accepted.json>
      Fails unless: the worker never crashed, every POST got 201, and at
      least one ingest POST happened (so the ingest path was exercised,
      not just the skip path).
"""
import json
import os
import sys
from datetime import datetime, timezone

BASE = "http://compat-backend"
STATION = {"station_id": "NEL-001", "device_id": "ESP32-001", "location": {"lat": 14.442, "lon": 79.986}}
# A window the bundled real wind archive covers, so a spike really runs the
# tracer and reaches the ingest POST (the live-wind path needs the network).
AS_OF = datetime(2025, 8, 2, tzinfo=timezone.utc)


def run(ctm_dir, responses_path, out_path):
    sys.path.insert(0, ctm_dir)
    os.chdir(ctm_dir)
    import requests_mock
    from cities.loader import load_city
    import scripts.source_direction_worker as worker

    responses = json.load(open(responses_path))
    out = {}
    for name, r in responses.items():
        with requests_mock.Mocker() as m:
            m.get(f"{BASE}/api/forecast/spike-check", status_code=r["status"], json=r["body"])
            m.post(f"{BASE}/api/source-direction/ingest", status_code=201, json={"status": "success", "id": "x"})
            try:
                result = worker.process_station(BASE, STATION, load_city("live_deployment"),
                                                "WORKER-SOURCE-DIRECTION", "compat-key", AS_OF, use_live_wind=False)
                crash = None
            except Exception as e:  # the thing this check exists to catch
                result, crash = None, f"{type(e).__name__}: {e}"
            ingest = [q.json() for q in m.request_history if q.method == "POST"]
        out[name] = {
            "crash": crash,
            "action": result and result.get("action"),
            "ingest": ingest,
            "run": worker.build_run_record(result, datetime.now(timezone.utc)) if result else None,
        }
    json.dump(out, open(out_path, "w"), default=str, indent=1)


def verify(label, captured_path, accepted_path):
    captured, accepted = json.load(open(captured_path)), json.load(open(accepted_path))
    problems, ingests = [], 0
    print(f"{label}:")
    for name, c in captured.items():
        a = accepted[name]
        statuses = [x["status"] for x in a["ingest"]] + ([a["runs"]["status"]] if a["runs"] else [])
        ingests += len(a["ingest"])
        print(f"  {name:18} worker={c['action'] or 'CRASH'} ingest={[x['status'] for x in a['ingest']]} "
              f"runs={a['runs'] and a['runs']['status']}")
        if c["crash"]:
            problems.append(f"{name}: worker crashed: {c['crash']}")
        problems += [f"{name}: POST got {s}: {e}" for s, e in
                     [(x["status"], x["error"]) for x in a["ingest"]] + ([(a["runs"]["status"], a["runs"]["error"])] if a["runs"] else [])
                     if s != 201]
        if not statuses:
            problems.append(f"{name}: nothing was POSTed")
    if ingests == 0:
        problems.append("no scenario reached the ingest POST -- only the skip path was checked")
    for p in problems:
        print(f"  FAIL {p}")
    return not problems


if __name__ == "__main__":
    if sys.argv[1] == "run":
        run(*sys.argv[2:5])
    else:
        sys.exit(0 if verify(*sys.argv[2:5]) else 1)
