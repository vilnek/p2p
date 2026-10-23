#!/bin/zsh
# Test lab: run the unit suite and the e2e suite N times in a row (default 5) and summarise every
# test that failed at least once. e2e runs through the lab port proxy (never takes port 4318).
#   zsh tests/lab/flaky.sh [N] [unit|e2e|both]
cd "${0:A:h}/../.."
N=${1:-5}
WHAT=${2:-both}
OUT=tests/lab/out/flaky-$(date +%Y%m%d-%H%M)
mkdir -p $OUT
if [[ $WHAT != e2e ]]; then
  for i in $(seq 1 $N); do
    npx vitest run --reporter=json --outputFile=$OUT/unit-$i.json > $OUT/unit-$i.log 2>&1
    echo "unit run $i: exit $?"
  done
fi
if [[ $WHAT != unit ]]; then
  # Build once; every run tests the same build.
  # Own build folder and ports, so lab runs can go on at the same time.
  export LAB_DIST=tests/lab/.dist-flaky LAB_PORT=4337 LAB_PROXY_PORT=4338 LAB_RESULTS=$OUT/results
  npx vite build --outDir $LAB_DIST --emptyOutDir --logLevel warn
  for i in $(seq 1 $N); do
    LAB_NOBUILD=1 LAB_JSON=$OUT/e2e-$i.json npx playwright test --config playwright.lab.config.ts --project=e2e ${LAB_WORKERS:+--workers=$LAB_WORKERS} > $OUT/e2e-$i.log 2>&1
    echo "e2e run $i: exit $?"
  done
fi
node tests/lab/flaky-summary.mjs $OUT | tee $OUT/summary.txt
