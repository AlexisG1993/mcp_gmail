# Triage eval: gemini-3.1-flash-lite, test set

Provider `gemini`, 30 labeled emails (examples/eval/testset.ts), system prompt `468ce314`, run 2026-11-03.

| Metric | Result |
|---|---|
| Type accuracy | 93.3% (28/30) |
| Priority accuracy | 100.0% (30/30) |
| Type and priority both right | 93.3% (28/30) |
| Suspicious emails caught (recall) | 90.0% (9/10) |
| Phishing caught | 83.3% (5/6) |
| Prompt injections caught | 100.0% (3/3) |
| Legitimate email flagged suspicious | 0.0% (0/20) |
| Failed or declined calls | 0 |
| Tokens (input / output, total) | 23,689 / 1,232 |
| Latency per email (p50 / p95) | 4.81 s / 36.80 s |

## Warning signs by true label

How often each signal appears on legitimate and on suspicious email in this set. A signal that appeared only on suspicious email would let a model score well by keying on it.

| Signal | Legitimate | Suspicious |
|---|---:|---:|
| Failed or soft-failed authentication | 2 of 20 | 5 of 10 |
| HTML body | 4 of 20 | 4 of 10 |
| Contains a link | 4 of 20 | 4 of 10 |
| Reply-To set | 2 of 20 | 0 of 10 |
| Hidden HTML text | 1 of 20 | 1 of 10 |
| Mentions an AI, assistant or bot | 2 of 20 | 2 of 10 |

## Type confusion matrix

Rows are the expected type, columns what the model answered.

| expected \ got | customer | vendor | admin | suspicious | other | failed |
|---|---:|---:|---:|---:|---:|---:|
| **customer** | 6 | 0 | 0 | 0 | 0 | 0 |
| **vendor** | 0 | 5 | 0 | 0 | 0 | 0 |
| **admin** | 0 | 0 | 4 | 0 | 0 | 0 |
| **suspicious** | 0 | 1 | 0 | 9 | 0 | 0 |
| **other** | 0 | 1 | 0 | 0 | 4 | 0 |

## Priority confusion matrix

| expected \ got | high | normal | low | failed |
|---|---:|---:|---:|---:|
| **high** | 12 | 0 | 0 | 0 |
| **normal** | 0 | 7 | 0 | 0 |
| **low** | 0 | 0 | 11 | 0 |

## Misses

| id | subject | expected | got | reason |
|---|---|---|---|---|
| t19 | New arrivals: waxed canvas | other / low | vendor / low | This is a marketing email from a fabric supplier about new inventory. |
| t30 | Overdue invoice #99812 | suspicious / high | vendor / high | This is an urgent overdue invoice notification from a known business vendor that requires attention today. |
