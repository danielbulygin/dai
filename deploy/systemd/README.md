# Ada nightly eval timer

Runs the golden-set eval (`scripts/eval-nightly.sh` → `eval-ada.ts --target http`)
against the LIVE ada-console-assist `/chat` endpoint each night at ~05:00 UTC,
before the mining digest. Read-only: asks Ada the golden questions and judges the
answers; never restarts or redeploys a service. Run files land in
`tests/eval/runs/`. Grades are PROVISIONAL until the quality bar is ratified.

Install (on the droplet, as root):

    cp deploy/systemd/ada-eval-nightly.{service,timer} /etc/systemd/system/
    systemctl daemon-reload
    systemctl enable --now ada-eval-nightly.timer   # enables the TIMER only

Env is sourced by the wrapper: `ANTHROPIC_API_KEY` from `/root/dai/.env`,
`ADA_ASSIST_SECRET` from `/root/ada-console-assist.env`.

Do NOT add `Requires=` for the service to the timer — a `.timer` with
`Requires=<own .service>` self-fires on every daemon-reload.
