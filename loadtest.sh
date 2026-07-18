#!/usr/bin/env bash
# Load test for the DEPLOYED app (free Render + Supabase free).
# Run from your own computer:  bash loadtest.sh
# Uses autocannon (no install needed via npx). Node must be installed.

BASE="https://coursel-31wj.onrender.com"

echo "==> 0. Wake the free instance (it sleeps when idle) and confirm backend is up"
curl -s "$BASE/api/meta"; echo; echo
sleep 3

echo "==> 1. Light DB endpoint (/api/colleges) — measures Supabase round-trip under load"
echo "    50 concurrent connections for 15 seconds"
npx -y autocannon -c 50 -d 15 "$BASE/api/colleges"

echo
echo "==> 2. REAL student dashboard (the actual student-side load)"
echo "    Fill in a real STUDENT_ID and your college ACCESS_CODE first, then re-run."
STUDENT_ID="PUT_A_REAL_STUDENT_ID_HERE"
ACCESS_CODE="PUT_YOUR_COLLEGE_CODE_HERE"
if [ "$STUDENT_ID" != "PUT_A_REAL_STUDENT_ID_HERE" ]; then
  npx -y autocannon -c 50 -d 15 "$BASE/api/student/$STUDENT_ID/dashboard?code=$ACCESS_CODE"
else
  echo "    (skipped — set STUDENT_ID and ACCESS_CODE above to run this one)"
fi

# HOW TO READ THE OUTPUT:
#   Req/Sec (avg)  -> sustainable requests per second
#   Latency p97.5  -> tail latency; keep it under ~1000ms for a good experience
#   Non-2xx / errors -> should be 0
#
# Each open student page makes ~1 request every 10 seconds, so:
#   max concurrent students  ~=  (sustained Req/Sec) x 10
# e.g. 40 req/s sustained with low latency  ->  ~400 concurrent students.
#
# Start at -c 50. If latency stays low and errors are 0, bump to -c 100, then -c 200
# to find where p97.5 latency climbs or errors appear — that's your ceiling.
