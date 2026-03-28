# Document Type System

> DB-backed, tenant-aware document type definitions with UI configuration (title templates, status colors, card/list/edit layouts), TTL-cached lookups, field inference, and a unified config API.

## Problem

When documents are stored as unstructured blobs, there is no way to enforce what properties a "person" should have versus a "recipe" versus a "project." The UI cannot render appropriate titles, subtitles, or status indicators without hardcoded per-type logic. Adding new document types requires code changes. And without tenant scoping, all users share the same type definitions, preventing customization.

## Context

- Multiple document types with different schemas, behaviors, and UI layouts
- Types are stored in a `document_types` PostgreSQL table, not in-memory registries
- System types (built-in) and tenant-specific types (custom) coexist with tenant types taking precedence
- The UI needs to resolve titles, subtitles, and status colors from type-specific behavior configuration
- Types rarely change during a request — a TTL cache eliminates redundant DB lookups
- New types must be creatable at runtime without code changes or deployments

## Solution

### DB-Backed Type Storage

Document types live in a `document_types` table with columns for slug, name, icon, schema hints, behaviors, property definitions, and layout configurations. Each column that stores complex data uses JSONB:

```javascript
// lib/document-types.js
// Type row structure after parsing:
{
  id, tenantId, slug, name, namePlural, icon, description,
  schemaHint,           // { fields: [{ name, type, required }] }
  behaviors,            // { titleTemplate, titleFields, statusColors, ... }
  propertyDefinitions,  // [{ key, type, label, options }]
  cardLayout,           // UI layout for card view
  listLayout,           // UI layout for list view
  editLayout,           // UI layout for edit form
  visibility,           // 'user' | 'system' | 'admin'
  isSystem,             // true for built-in types
}
```

### Tenant-Aware Lookup with System Fallback

Type lookups first check tenant-specific types, then fall back to system types:

```javascript
// lib/document-types.js
async function get(slug, tenantId = null) {
  const tid = tenantId || 1
  const cacheKey = getCacheKey(slug, tid)

  const cached = typeCache.get(cacheKey)
  if (cached !== undefined) return cached

  // Try tenant-specific type first
  const tenantType = await select('document_types')
    .where('slug = ?', slug)
    .where('tenant_id = ?', tid)
    .one()

  if (tenantType) {
    const result = parseType(tenantType)
    typeCache.set(cacheKey, result)
    return result
  }

  // Fall back to system type
  const systemType = await select('document_types')
    .skipTenantScope()
    .where('slug = ?', slug)
    .where('is_system = true')
    .one()

  const result = systemType ? parseType(systemType) : null
  typeCache.set(cacheKey, result)
  return result
}
```

### TTL Cache for Hot Path

A 60-second TTL cache wraps type lookups. Since types rarely change, this eliminates the DB round-trip on every document render:

```javascript
// lib/document-types.js
const { createTTLCache } = require('./utils/ttl-cache')
const typeCache = createTTLCache(60000)

function getCacheKey(slug, tenantId) {
  return `${tenantId || 'system'}:${slug}`
}
```

Cache invalidation happens on type updates:

```javascript
async function updateType(slug, updates) {
  // ... apply updates to DB ...
  typeCache.invalidate(getCacheKey(slug, tenantId))
  return get(slug, tenantId)
}
```

### Batch Fetch to Avoid N+1

When rendering a list of documents with mixed types, `getMany()` fetches all needed types in two queries (tenant + system) instead of N individual lookups:

```javascript
// lib/document-types.js
async function getMany(slugs, tenantId = null) {
  const result = new Map()
  const uncachedSlugs = []

  // Check cache first
  for (const slug of slugs) {
    const cached = typeCache.get(getCacheKey(slug, tid))
    if (cached !== undefined) result.set(slug, cached)
    else uncachedSlugs.push(slug)
  }

  if (uncachedSlugs.length === 0) return result

  // Batch fetch tenant types
  const tenantTypes = await raw(
    `SELECT * FROM document_types WHERE slug = ANY($1) AND tenant_id = $2`,
    [uncachedSlugs, tid]
  )
  // ... populate result, find still-missing slugs ...

  // Batch fetch system types for remaining
  const systemTypes = await raw(
    `SELECT * FROM document_types WHERE slug = ANY($1) AND is_system = true`,
    [stillMissing]
  )

  return result
}
```

### UI Behavior Resolution

Type behaviors configure how the UI renders documents. The module provides resolution functions that interpolate templates with document data:

```javascript
// lib/document-types.js
function interpolate(template, data) {
  if (!template || !data) return null
  return template.replace(/\{\{(.+?)\}\}/g, (_, expr) => {
    // Handle fallback syntax: {{a || b}}
    const parts = expr.split('||').map((p) => p.trim())
    for (const part of parts) {
      const value = data[part]
      if (value !== undefined && value !== null && value !== '') return String(value)
    }
    return ''
  }).trim() || null
}

function resolveTitle(typeDef, data) {
  const b = typeDef?.behaviors || {}
  if (b.titleTemplate) {
    const result = interpolate(b.titleTemplate, data)
    if (result) return result
  }
  if (b.titleFields) {
    for (const field of b.titleFields) {
      if (data[field]) return String(data[field])
    }
  }
  return b.titleFallback || null
}

function resolveStatusColor(typeDef, data) {
  const b = typeDef?.behaviors || {}
  if (!b.statusColors) return null
  const statusField = b.statusField || 'status'
  return b.statusColors[data[statusField]] || null
}
```

A behavior object might look like:

```javascript
{
  titleTemplate: '{{name}}',
  titleFields: ['name', 'title'],
  titleFallback: 'Untitled',
  subtitleTemplate: '{{company || role}}',
  subtitleMaxLength: 80,
  statusField: 'status',
  statusColors: {
    active: 'green',
    inactive: 'gray',
    blocked: 'red',
  },
  autoPin: false,
  defaultWidget: 'card',
  widgetSize: { width: 2, height: 2 },
}
```

### Runtime Type Creation

New types can be created at runtime without code changes. The creation is idempotent — if the slug already exists, the existing type is returned:

```javascript
// lib/document-types.js
async function create(typeData) {
  if (!/^[a-z][a-z0-9_]*$/.test(typeData.slug)) {
    throw new Error('Type slug must start with a letter and contain only lowercase letters, numbers, and underscores')
  }

  const existing = await get(typeData.slug, tenantId)
  if (existing) return existing

  await insert('document_types', {
    tenant_id: tenantId,
    slug: typeData.slug,
    name: typeData.name,
    name_plural: typeData.namePlural || typeData.name + 's',
    icon: typeData.icon || '\ud83d\udcc4',
    schema_hint: jsonStringify(typeData.schemaHint),
    behaviors: jsonStringify(typeData.behaviors) || '{}',
    property_definitions: jsonStringify(typeData.propertyDefinitions),
    card_layout: jsonStringify(typeData.cardLayout),
    list_layout: jsonStringify(typeData.listLayout),
    edit_layout: jsonStringify(typeData.editLayout),
    visibility: typeData.visibility || 'user',
    is_system: false,
  })

  return get(typeData.slug, tenantId)
}
```

### Field Inference

When new data arrives for a type, the system can suggest fields based on value patterns:

```javascript
// lib/document-types.js
const FIELD_PATTERNS = [
  { pattern: /^\d{4}-\d{2}-\d{2}$/, type: 'date' },
  { pattern: /^\d{4}-\d{2}-\d{2}T/, type: 'datetime' },
  { pattern: /^[\w.+-]+@[\w.-]+\.[a-z]{2,}$/i, type: 'email' },
  { pattern: /^https?:\/\//, type: 'url' },
  { pattern: /^\+?[\d\s()-]{10,}$/, type: 'phone' },
]

function inferFieldType(value) {
  if (typeof value === 'boolean') return { type: 'boolean' }
  if (typeof value === 'number') return { type: 'number' }
  if (Array.isArray(value)) return { type: 'list' }
  if (typeof value === 'string') {
    for (const { pattern, type } of FIELD_PATTERNS) {
      if (pattern.test(value)) return { type }
    }
    return value.length > 200 ? { type: 'text', options: { long: true } } : { type: 'text' }
  }
  if (typeof value === 'object') return { type: 'object' }
  return null
}
```

### Attribute Accessors

Generic getter/updater factories reduce boilerplate for accessing specific type attributes:

```javascript
// lib/document-types.js
function createAttributeGetter(attr) {
  return async function (slug) {
    const type = await get(slug)
    return type?.[attr] || null
  }
}

const getSchemaHint = createAttributeGetter('schemaHint')
const getBehaviors = createAttributeGetter('behaviors')
const getCardLayout = createAttributeGetter('cardLayout')
// etc.
```

## Implications

- DB-backed types enable runtime creation without deployments — the agent or admin can create new document types on the fly
- Tenant-aware lookup with system fallback means each tenant can customize types while sharing a common base
- The 60-second TTL cache trades freshness for performance — type changes take up to a minute to propagate, which is acceptable since types change rarely
- `getMany()` batch fetching is critical for list views — without it, rendering 50 documents of 10 different types would make 10 DB queries instead of 2
- Template interpolation with `{{field || fallback}}` syntax handles missing data gracefully without requiring every document to have every field populated
- Status colors are configured per-type, not per-status globally — the same status string can have different colors in different type contexts
- Field inference is a suggestion mechanism, not enforcement — inferred fields help build schema hints but do not constrain document data
- Safe deletion requires checking document count first — the system refuses to delete types with existing documents

## Code Example

```javascript
// Rendering a document list with resolved titles and status colors
const types = require('../document-types')

async function renderDocumentList(documents) {
  const slugs = [...new Set(documents.map((d) => d.type))]
  const typeMap = await types.getMany(slugs)

  return documents.map((doc) => {
    const typeDef = typeMap.get(doc.type)
    return {
      id: doc.id,
      title: types.resolveTitle(typeDef, doc.data) || doc.data.title || 'Untitled',
      subtitle: types.resolveSubtitle(typeDef, doc.data),
      statusColor: types.resolveStatusColor(typeDef, doc.data),
      icon: typeDef?.icon || '\ud83d\udcc4',
      type: typeDef?.name || doc.type,
    }
  })
}

// Creating a custom type at runtime
await types.create({
  slug: 'recipe',
  name: 'Recipe',
  namePlural: 'Recipes',
  icon: '\ud83c\udf73',
  behaviors: {
    titleTemplate: '{{name}}',
    subtitleTemplate: '{{cuisine || category}}',
    statusColors: { draft: 'yellow', tested: 'green', published: 'blue' },
  },
  visibility: 'user',
})
```

## Related Patterns

- [Entity Service and Universal CRUD](./entity-service-and-universal-crud.md)
- [Validation and Schema System](./validation-and-schema-system.md)
- [Widget SDK and Declarative UI](./widget-sdk-and-declarative-ui.md)
