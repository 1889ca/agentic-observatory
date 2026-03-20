# Contact Resolution & Entity Disambiguation

> Fuzzy-matches names, emails, and handles across multiple platforms to resolve mentions to a unified contact profile, with confidence scoring for ambiguous cases.

## Problem

Users refer to people informally — "John", "the guy from Acme", "j.smith@..." — without specifying which system they mean. Without cross-platform resolution, the same person appears as separate, unlinked records in Gmail, GitHub, and Slack. The system either returns the wrong contact, asks redundant clarifying questions, or silently uses the first match and produces incorrect downstream actions (messaging the wrong person, attributing the wrong commit author).

## Context

This pattern applies when an agent:
- Operates across multiple connected platforms (email, VCS, messaging, CRM)
- Receives natural-language references to people that are incomplete, informal, or ambiguous
- Must take actions on behalf of a specific individual (send a message, look up history, trigger a workflow)
- Needs to build relationship context that spans platforms

## Solution

Resolution proceeds in a ranked pipeline: exact match first, then fuzzy match, then cross-source aggregation, then confidence arbitration.

**Fuzzy matching** runs independently against each source using normalized forms of name, email, and handle. Each candidate receives a per-source confidence score based on match quality (exact email = 1.0, partial name = 0.4–0.7).

**Multi-source aggregation** merges candidates that share a common identifier (email address is the canonical key). A merged profile accumulates all known handles and names from every source, weighted by source reliability.

**Confidence arbitration** collapses the candidate list. If a single candidate exceeds the acceptance threshold (e.g., 0.85), it is returned as resolved. If multiple candidates score above the ambiguity threshold (e.g., 0.5), the system emits a disambiguation request — it does not guess.

**Resolved entities are cached** with a TTL. Cache entries are invalidated on explicit profile updates or when a source reports a changed email.

```js
// Resolution pipeline entry point
async function resolveContact(mention, sources = ['gmail', 'github', 'slack']) {
  const cached = await contactCache.get(mention);
  if (cached) return cached;

  const candidates = await Promise.all(
    sources.map(src => querySource(src, mention))
  );

  const merged = mergeByEmail(candidates.flat());
  const scored = merged.map(c => ({ ...c, score: computeConfidence(c) }));
  scored.sort((a, b) => b.score - a.score);

  if (scored[0]?.score >= ACCEPTANCE_THRESHOLD) {
    const resolved = buildUnifiedProfile(scored[0]);
    await contactCache.set(mention, resolved, CACHE_TTL_MS);
    return { status: 'resolved', profile: resolved };
  }

  const ambiguous = scored.filter(c => c.score >= AMBIGUITY_THRESHOLD);
  if (ambiguous.length > 1) {
    return { status: 'ambiguous', candidates: ambiguous };
  }

  return { status: 'unresolved' };
}
```

**Disambiguation flow** surfaces ambiguous candidates to the user with enough context to choose (display name, platform, last-seen date). The chosen resolution is cached with a higher-confidence override so the same mention resolves immediately in the future.

**Unified profile construction** merges all source records for a resolved entity:

```js
function buildUnifiedProfile(candidate) {
  return {
    id: `contact:${candidate.canonicalEmail}`,
    displayName: candidate.names[0],          // highest-confidence name
    email: candidate.canonicalEmail,
    handles: {
      github: candidate.sources.github?.login,
      slack: candidate.sources.slack?.userId,
    },
    avatarUrl: candidate.sources.gmail?.photoUrl
             ?? candidate.sources.github?.avatarUrl,
    sourcesFound: Object.keys(candidate.sources),
    resolvedAt: Date.now(),
  };
}
```

## Implications

- Email address is the canonical merge key; contacts without a shared email will not be merged across sources even if they are the same person.
- Fuzzy name matching has inherent false-positive risk for common names; the confidence threshold is a tuning parameter that trades recall against precision.
- Ambiguous resolution requests interrupt the agent's flow and require a round-trip to the user; minimize this by using richer context (recent conversation history, active project entities) to bias scoring before falling back to clarification.
- Caching resolved contacts improves speed but can serve stale data; invalidation must be triggered by platform webhook events (e.g., email change, account deletion).
- Sources that are slow or unavailable are skipped gracefully — the system resolves against available sources and notes which sources were excluded in the profile metadata.
- Building a unified profile creates a derived record that must not be treated as authoritative over source systems; always write back to the canonical source, never to the unified profile.

## Code Example

```js
// Fuzzy matching against a single source
async function querySource(sourceName, mention) {
  const source = sourceAdapters[sourceName];
  const contacts = await source.search(mention);

  return contacts.map(contact => ({
    sourceName,
    canonicalEmail: contact.email,
    names: [contact.displayName, ...(contact.aliases ?? [])],
    handle: contact.handle,
    score: fuzzyScore(mention, {
      name: contact.displayName,
      email: contact.email,
      handle: contact.handle,
    }),
    sources: { [sourceName]: contact },
  }));
}

function fuzzyScore(mention, fields) {
  const scores = [
    fields.email && mention.includes('@')
      ? stringSimilarity(mention, fields.email) * 1.0
      : 0,
    stringSimilarity(mention, fields.name ?? '') * 0.75,
    stringSimilarity(mention, fields.handle ?? '') * 0.6,
  ];
  return Math.max(...scores);
}
```

## Related Patterns

- [Knowledge Graph and Relationship Discovery](./knowledge-graph-and-relationship-discovery.md)
- [Relationship Health Monitoring](./relationship-health-monitoring.md)
- [Unified Search Across KBs](./unified-search-across-kbs.md)
