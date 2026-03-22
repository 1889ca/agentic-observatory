# Document Type System

> Type-based document handling with property validation, cross-type properties, and bidirectional task relationships.

## Problem

When documents are stored as unstructured blobs, there's no way to enforce what properties a "meeting note" should have versus a "specification" versus an "incident report." Invalid data creeps in, queries return inconsistent shapes, and the relationship between documents and the tasks that produced or consume them is lost. Every consumer ends up writing its own validation, and none of them agree.

## Context

- Multiple document types with different required/optional properties (notes, specs, reports, decisions)
- Properties that span multiple document types (e.g., "priority" applies to specs and incidents, "author" applies to everything)
- Documents linked to tasks bidirectionally — a task produces documents, a document references tasks
- Type validation must run before creation and update to catch bad data at the boundary
- New document types need to be addable without modifying core logic

## Solution

Document types are defined in a registry that specifies valid properties and constraints per type. Properties themselves are first-class — they declare which types they belong to, enabling cross-type queries. Task relationships link documents to tasks bidirectionally. Type validation runs as a gate before any create or update operation.

```javascript
// document-types.js
const typeRegistry = new Map();

function defineDocumentType(typeName, schema) {
  typeRegistry.set(typeName, {
    name: typeName,
    properties: schema.properties,   // { name: { type, required, default } }
    constraints: schema.constraints,  // Custom validation functions
  });
}

function validateDocument(typeName, data) {
  const typeDef = typeRegistry.get(typeName);
  if (!typeDef) throw new Error(`Unknown document type: ${typeName}`);

  const errors = [];

  for (const [prop, spec] of Object.entries(typeDef.properties)) {
    if (spec.required && data[prop] == null) {
      errors.push(`Missing required property: ${prop}`);
    }
    if (data[prop] != null && typeof data[prop] !== spec.type) {
      errors.push(`${prop} must be ${spec.type}, got ${typeof data[prop]}`);
    }
  }

  // Reject unknown properties
  for (const key of Object.keys(data)) {
    if (!typeDef.properties[key]) {
      errors.push(`Unknown property for ${typeName}: ${key}`);
    }
  }

  for (const constraint of typeDef.constraints || []) {
    const err = constraint(data);
    if (err) errors.push(err);
  }

  return errors;
}
```

Task-document relationships are stored as a join table with direction metadata, enabling bidirectional traversal:

```javascript
// document-tasks.js
async function linkDocumentToTask(db, { documentId, taskId, relationship }) {
  await db.query(`
    INSERT INTO document_tasks (document_id, task_id, relationship)
    VALUES ($1, $2, $3)
    ON CONFLICT (document_id, task_id) DO UPDATE SET relationship = $3
  `, [documentId, taskId, relationship]);
}

async function getTaskDocuments(db, taskId) {
  return db.query('SELECT * FROM documents d JOIN document_tasks dt ON d.id = dt.document_id WHERE dt.task_id = $1', [taskId]);
}

async function getDocumentTasks(db, documentId) {
  return db.query('SELECT * FROM tasks t JOIN document_tasks dt ON t.id = dt.task_id WHERE dt.document_id = $1', [documentId]);
}
```

## Implications

- Adding a new document type is a registry call, not a schema migration — but new properties that need indexing still require DB changes
- Cross-type properties enable queries like "all documents with priority > high" regardless of type, but the property must be consistently named and typed across types
- Strict unknown-property rejection prevents data drift but requires updating the type definition before adding new fields
- Bidirectional task links add storage overhead but eliminate the need for reverse-lookup queries or denormalized references
- Validation at the boundary means internal code can trust document shape — no defensive checks deeper in the stack

## Code Example

```javascript
// Define types with shared and unique properties
defineDocumentType('meeting-note', {
  properties: {
    title:       { type: 'string', required: true },
    author:      { type: 'string', required: true },
    attendees:   { type: 'object', required: false },
    content:     { type: 'string', required: true },
    actionItems: { type: 'object', required: false },
  },
});

defineDocumentType('specification', {
  properties: {
    title:    { type: 'string', required: true },
    author:   { type: 'string', required: true },
    priority: { type: 'string', required: true },
    content:  { type: 'string', required: true },
    status:   { type: 'string', required: true },
  },
  constraints: [
    (data) => !['draft','review','approved'].includes(data.status)
      ? `Invalid status: ${data.status}` : null,
  ],
});

// Validated creation
async function createDocument(db, typeName, data, taskId) {
  const errors = validateDocument(typeName, data);
  if (errors.length) throw new Error(`Validation failed: ${errors.join(', ')}`);

  const doc = await db.query(
    'INSERT INTO documents (type, data) VALUES ($1, $2) RETURNING id',
    [typeName, JSON.stringify(data)]
  );

  if (taskId) {
    await linkDocumentToTask(db, { documentId: doc.rows[0].id, taskId, relationship: 'produced-by' });
  }

  return doc.rows[0];
}
```

## Related Patterns

- [Entity Service and Universal CRUD](./entity-service-and-universal-crud.md)
- [Knowledge Graph and Relationship Discovery](./knowledge-graph-and-relationship-discovery.md)
