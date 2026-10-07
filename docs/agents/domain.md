# Domain docs

How the engineering skills read the domain docs of this repo when they explore the code.

## Read these before you explore

- **`docs/GLOSSARY.md`**: the glossary. The repo root has no `GLOSSARY.md`.
- **`docs/adr/`**: the architecture decision records. Read the ADRs that touch the area you will work in.

A file in this list can be missing. Go on without it. Do not report that it is missing. Do not suggest that a person create it first. The `/domain-modeling` skill creates these files when a term or a decision is settled. This repo has no ADR at this time.

## File structure

This repo has one context.

```
/
├── docs/
│   ├── GLOSSARY.md
│   └── adr/
└── src/
```

`docs/` is the source of truth. CI publishes it to the GitHub wiki. The workflow is `.github/workflows/wiki.yml` and it watches the path `docs/**`. The wiki has a flat structure, so each file name in `docs/` must be unique.

## Use the vocabulary of the glossary

Your output can name a domain concept. It can be an issue title, a refactor plan, a hypothesis or a test name. Use the term as `docs/GLOSSARY.md` defines it. Do not use a synonym that the glossary says to avoid.

Sometimes the glossary has no term for the concept you need. Then you invent language that the project does not use, or the glossary has a gap. Think again, or note the gap for `/domain-modeling`.

## Flag ADR conflicts

Your output can contradict an ADR. Say so. Do not override it in silence. For example:

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_
