# CSV list cleaner (Python)

Clean a contact list before a CRM import or a transactional send: dedupe, validate, and add a verdict to every row.

```bash
pip install -r requirements.txt
python clean_list.py list.csv cleaned.csv                       # no key: the public sandbox key
MOBILEVALIDATE_API_KEY=mv_test_… python clean_list.py leads.csv cleaned.csv --checks whatsapp,telegram
```

- Finds a `phone` / `number` / `mobile` / `msisdn` / `e164` column and/or an `email` column.
- Sends each distinct value once: a real-time lookup for up to 100 values, otherwise a bulk job (`jobs.create` →
  `jobs.wait` → `jobs.results`, which pages automatically).
- Adds `verdict` (`ok`, `not_reachable`, `check_address`, `unknown`, `invalid`, `duplicate`), `reachable_on`
  (e.g. `whatsapp`) and `suggestion` (how to fix an invalid value).
- `unknown` answers are never billed and are kept as `unknown`: don't delete those contacts.
- Prints counts only, never numbers or addresses.

The sample [`list.csv`](list.csv) uses test values only, so it runs with the sandbox key (sandbox jobs are limited to
10 rows; use a personal test key or a live key for bigger files).
