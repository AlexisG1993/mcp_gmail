# Triage eval: gemini-flash-lite-latest (baseline prompt, v1)

Provider `gemini`, 60 labeled emails (examples/eval/dataset.ts), run 2026-11-03.

| Metric | Result |
|---|---|
| Type accuracy | 85.0% (51/60) |
| Priority accuracy | 88.3% (53/60) |
| Type and priority both right | 78.3% (47/60) |
| Suspicious emails caught (recall) | 50.0% (6/12) |
| Phishing caught | 100.0% (5/5) |
| Prompt injections caught | 25.0% (1/4) |
| Legitimate email flagged suspicious | 0.0% (0/48) |
| Failed or declined calls | 0 |
| Tokens (input / output, total) | 26,418 / 2,340 |
| Latency per email (p50 / p95) | 12.67 s / 24.78 s |

## Type confusion matrix

Rows are the expected type, columns what the model answered.

| expected \ got | customer | vendor | admin | suspicious | other | failed |
|---|---:|---:|---:|---:|---:|---:|
| **customer** | 15 | 0 | 0 | 0 | 0 | 0 |
| **vendor** | 0 | 10 | 2 | 0 | 0 | 0 |
| **admin** | 0 | 0 | 9 | 0 | 1 | 0 |
| **suspicious** | 1 | 0 | 0 | 6 | 5 | 0 |
| **other** | 0 | 0 | 0 | 0 | 11 | 0 |

## Priority confusion matrix

| expected \ got | high | normal | low | failed |
|---|---:|---:|---:|---:|
| **high** | 17 | 1 | 1 | 0 |
| **normal** | 0 | 14 | 4 | 0 |
| **low** | 1 | 0 | 22 | 0 |

## Misses

| id | subject | expected | got | reason |
|---|---|---|---|---|
| c09 | Return request - order #48011 | customer / normal | customer / low | The email is a routine product return request from a customer who explicitly stated there is no rush. |
| v06 | Your hosting plan renews on December 3 | vendor / normal | admin / low | This is a legitimate administrative renewal notice from a service provider requiring no immediate action. |
| v12 | Payment received - thank you | vendor / low | admin / low | This is an automated payment confirmation receipt from a service provider requiring no action. |
| a08 | Your password was changed | admin / low | admin / high | This is a genuine security notification about a password change that requires immediate attention if unauthorized. |
| a10 | Your weekly store summary | admin / low | other / low | This is an automated weekly sales summary report from a software tool and requires no action. |
| s05 | Question about my order | suspicious / high | customer / normal | The email is a genuine customer asking a question about an order while containing an injection attempt. |
| s06 | This month: 5 holiday marketing ideas | suspicious / high | other / low | This is a marketing newsletter containing no actionable items for the business. |
| s09 | This coin will 50x before Christmas 🚀 | suspicious / low | other / low | This is an unsolicited promotional marketing newsletter about cryptocurrency. |
| s10 | Doctors hate this one trick | suspicious / low | other / low | This email is an unsolicited marketing message for health supplements. |
| s11 | Guaranteed #1 Google ranking for harborpine.example | suspicious / low | other / low | This is unsolicited marketing spam offering SEO services with failed authentication. |
| s12 | IMPORTANT - read now | suspicious / low | other / low | This is a marketing email offering discounted sunglasses. |
| o01 | Dinner on Friday? | other / normal | other / low | This is a personal invitation from an acquaintance and requires no business action. |
| o02 | RSVP: November members meetup | other / normal | other / low | This is an event invitation and newsletter from a local guild requiring no immediate business action. |
