# Skylark BI Agent

> **Your business, understood.**

Skylark BI Agent is a conversational business intelligence system built for founder- and leadership-level questions over live business data.

Instead of asking a user to build spreadsheets, write queries, or manually reconcile operational data, Skylark lets them ask questions in natural language and receive answers grounded in two connected monday.com boards:

- **Deals** — sales pipeline, opportunities and commercial activity
- **Work Orders** — project execution, billing, collections and operational activity

A question such as:

> **"How is our pipeline looking this quarter?"**

or:

> **"Which customers have both active work and open opportunities?"**

can be answered through the same interface, with the underlying figures, reasoning and data-quality limitations surfaced alongside the answer.

The goal is not simply to make a chatbot that can read a spreadsheet.

The goal is to build an **auditable business intelligence agent** where the model interprets the question, deterministic code performs the analysis, and the final answer clearly communicates both the result and how much of the underlying data supports it.

---

# 1. What Skylark Does

## Conversational business intelligence

Skylark turns natural-language business questions into structured analytical workflows.

A user can ask about:

- pipeline performance
- sector performance
- expected revenue
- operational execution
- billing and collections
- receivables
- stalled deals
- overdue work
- cross-board customer relationships
- leadership-level business risks
- data reliability

The user does not need to know the underlying board structure or analytics implementation.

The agent determines which analytical tools are required, retrieves the relevant information, and presents the result conversationally.

### Examples

| Question | What Skylark analyses |
|---|---|
| How is our pipeline looking this quarter? | Open pipeline, stages, value and coverage |
| Which sectors are performing best? | Pipeline, win rate, order book and billing |
| Which customers have both active work and pipeline opportunities? | Cross-board account matching |
| What is our expected revenue? | Order book, billed and collected amounts |
| What operational risks should leadership know about? | Rule-based operational and commercial risks |
| Give me a leadership update. | Consolidated leadership briefing data |
| How reliable is this data? | Completeness, malformed values and unresolved fields |

---

## The key design decision: the model never does the arithmetic

A conventional LLM-based data chatbot can ask a model to inspect records and calculate totals.

That creates a fundamental reliability problem.

Language models are good at interpreting language and reasoning about what information is relevant, but they are not the right place to perform deterministic business arithmetic over hundreds of records.

Skylark deliberately separates those responsibilities.

**The LLM interprets.  
Tools retrieve.  
Analytics calculate.  
The LLM explains.**

All business arithmetic lives in deterministic TypeScript under:

```text
src/lib/analytics
