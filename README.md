# Repo Brain

Repo Brain reads a repository's git history and pull-request reviews into a
FalkorDB graph (who touched which files, which files change together, who
reviewed what). It then answers four questions from the command line: what
else moves when I touch this file (`impact`), where knowledge is concentrated
in one person (`risk`), who should review this PR (`review`), and the headline
one, `fix`. `fix` uses max-flow / min-cut to prescribe the smallest set of
review assignments that spreads that knowledge, without assigning anyone who
lacks the expertise to review well. Built for FalkorDB Graph Hacks, Oct 2026.

```bash
npm install
npm run brain -- parse /path/to/repo   # git history -> counts, no database needed
npm test
```
