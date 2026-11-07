# Complement settings

Run `bash complement/run.sh` inside the project test VM. The runner builds one
image and prepares one blacklisted checkout, then runs the default pass and
each row of `settings.tsv` separately. A row names a top-level test and its
space-separated environment overrides. The default pass excludes those tests;
each settings pass runs only its named test. The original `-run` expression
applies to every pass, including subtest paths. Both JSON streams contribute to
`baseline.jsonl` and `BASELINE.md`; per-pass logs and `runs.tsv` are in `work-*`.

`TestUnrejectRejectedEvents` uses
`PASS_COMMUNICO_FEDERATION_UNGROUNDEDMILLIHOURS=0`, the explicitly supported drop
behavior from the M5b rooms-over-federation plan, ruling B. Complement saves its
sync token after A arrives, then expects B only when B is resent. With the
default non-zero lifespan, communico retains B and admits it immediately when
its missing parent A arrives, so that sync already contains A followed by B.
With zero, B is dropped initially and its redelivery is its first admission.
The native HTTP federation transaction tests cover both settings through real
`/send`, `/sync` and `/messages` routes, including ordered and duplicate-free
delivery. The blacklist is independent of these settings.
