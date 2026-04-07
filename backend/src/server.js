const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs/promises");
const multer = require("multer");
const { initDb } = require("./db");

const app = express();
app.use(cors());
app.use(express.json());

const UPLOADS_DIR = path.resolve(process.cwd(), "uploads");
const PUBLIC_UPLOAD_PREFIX = "/uploads";

const storage = multer.diskStorage({
  destination: async (_req, _file, cb) => {
    try {
      await fs.mkdir(UPLOADS_DIR, { recursive: true });
      cb(null, UPLOADS_DIR);
    } catch (err) {
      cb(err);
    }
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 10)}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype || !file.mimetype.startsWith("image/")) {
      cb(new Error("Only image files are allowed"));
      return;
    }
    cb(null, true);
  }
});

app.use(PUBLIC_UPLOAD_PREFIX, express.static(UPLOADS_DIR));

const isObject = (value) => value && typeof value === "object" && !Array.isArray(value);

function personIsDeceasedFlag(payload) {
  return payload.isDeceased === true || payload.isDeceased === 1 ? 1 : 0;
}

function personDeathDateOrNull(payload) {
  const d = payload.deathDate;
  if (d == null || d === "") return null;
  return String(d);
}

let db;

app.get("/api/health", async (_req, res, next) => {
  try {
    const row = await db.get("SELECT 1 AS ok");
    res.json({ healthy: row.ok === 1 });
  } catch (error) {
    next(error);
  }
});

app.get("/api/users", async (_req, res, next) => {
  try {
    const rows = await db.all("SELECT id, name, is_admin AS isAdmin FROM users ORDER BY is_admin DESC, name ASC");
    res.json(rows);
  } catch (error) {
    next(error);
  }
});

async function getStoredAdminPin() {
  const row = await db.get("SELECT value FROM app_settings WHERE key = 'admin_pin'");
  if (row?.value) return row.value;
  return process.env.ADMIN_PIN || "admin";
}

app.post("/api/admin/verify-pin", async (req, res, next) => {
  try {
    const { pin } = req.body;
    if (typeof pin !== "string") {
      return res.status(400).json({ error: "Code requis" });
    }
    const stored = await getStoredAdminPin();
    if (pin !== stored) {
      return res.status(401).json({ error: "Code administrateur incorrect" });
    }
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/admin/change-pin", async (req, res, next) => {
  try {
    const { currentPin, newPin } = req.body;
    if (typeof currentPin !== "string" || typeof newPin !== "string") {
      return res.status(400).json({ error: "Codes requis" });
    }
    if (newPin.length < 4) {
      return res.status(400).json({ error: "Le nouveau code doit contenir au moins 4 caractères" });
    }
    const stored = await getStoredAdminPin();
    if (currentPin !== stored) {
      return res.status(401).json({ error: "Code actuel incorrect" });
    }
    await db.run("INSERT INTO app_settings (key, value) VALUES ('admin_pin', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [newPin]);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/users", async (req, res, next) => {
  try {
    const { name, isAdmin = false } = req.body;
    if (!name || typeof name !== "string") {
      return res.status(400).json({ error: "Name is required" });
    }
    const result = await db.run("INSERT INTO users (name, is_admin) VALUES (?, ?)", [name.trim(), isAdmin ? 1 : 0]);
    res.status(201).json({ id: result.lastID, name: name.trim(), isAdmin: Boolean(isAdmin) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/uploads", upload.single("image"), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Image file is required" });
    res.status(201).json({ url: `${PUBLIC_UPLOAD_PREFIX}/${req.file.filename}` });
  } catch (error) {
    next(error);
  }
});

app.get("/api/tree", async (_req, res, next) => {
  try {
    const people = await db.all(
      "SELECT id, first_name AS firstName, last_name AS lastName, gender, birth_date AS birthDate, death_date AS deathDate, is_deceased AS isDeceased, photo_url AS photoUrl, notes FROM people WHERE deleted_at IS NULL ORDER BY id ASC"
    );
    const relationships = await db.all(
      "SELECT id, source_person_id AS sourcePersonId, target_person_id AS targetPersonId, relationship_type AS relationshipType FROM relationships WHERE deleted_at IS NULL ORDER BY id ASC"
    );
    res.json({ people, relationships });
  } catch (error) {
    next(error);
  }
});

app.get("/api/requests", async (req, res, next) => {
  try {
    const status = req.query.status || "pending";
    const rows = await db.all(
      `SELECT cr.id, cr.entity_type AS entityType, cr.action_type AS actionType, cr.entity_id AS entityId,
            cr.payload_json AS payloadJson, cr.status, cr.review_note AS reviewNote, cr.created_at AS createdAt,
            requester.id AS requesterId, requester.name AS requesterName, reviewer.name AS reviewerName
     FROM change_requests cr
     JOIN users requester ON requester.id = cr.requested_by
     LEFT JOIN users reviewer ON reviewer.id = cr.reviewed_by
     WHERE cr.status = ?
     ORDER BY cr.created_at ASC`,
      [status]
    );
    const normalized = rows.map((row) => ({ ...row, payload: JSON.parse(row.payloadJson || "{}") }));
    res.json(normalized);
  } catch (error) {
    next(error);
  }
});

/** Applies payload to people/relationships tables. Returns { newPersonId } when a person row was created. */
async function mutateGenealogyChange(entityType, actionType, entityId, payload) {
  if (entityType === "person" && actionType === "create") {
    const insertResult = await db.run(
      "INSERT INTO people (first_name, last_name, gender, birth_date, death_date, is_deceased, photo_url, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        payload.firstName,
        payload.lastName,
        payload.gender || null,
        payload.birthDate || null,
        personDeathDateOrNull(payload),
        personIsDeceasedFlag(payload),
        payload.photoUrl || null,
        payload.notes || null
      ]
    );
    return { newPersonId: insertResult.lastID };
  }
  if (entityType === "person" && actionType === "update") {
    await db.run(
      "UPDATE people SET first_name = ?, last_name = ?, gender = ?, birth_date = ?, death_date = ?, is_deceased = ?, photo_url = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NULL",
      [
        payload.firstName,
        payload.lastName,
        payload.gender || null,
        payload.birthDate || null,
        personDeathDateOrNull(payload),
        personIsDeceasedFlag(payload),
        payload.photoUrl || null,
        payload.notes || null,
        entityId
      ]
    );
    return {};
  }
  if (entityType === "person" && actionType === "delete") {
    await db.run("UPDATE people SET deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NULL", [entityId]);
    await db.run(
      "UPDATE relationships SET deleted_at = CURRENT_TIMESTAMP WHERE (source_person_id = ? OR target_person_id = ?) AND deleted_at IS NULL",
      [entityId, entityId]
    );
    return {};
  }
  if (entityType === "relationship" && actionType === "create") {
    await db.run(
      "INSERT INTO relationships (source_person_id, target_person_id, relationship_type) VALUES (?, ?, ?)",
      [payload.sourcePersonId, payload.targetPersonId, payload.relationshipType]
    );
    return {};
  }
  if (entityType === "relationship" && actionType === "delete") {
    await db.run("UPDATE relationships SET deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NULL", [entityId]);
    return {};
  }
  throw new Error("Unsupported request type");
}

app.post("/api/requests", async (req, res, next) => {
  try {
    const { actorId, entityType, actionType, entityId = null, payload } = req.body;
    if (!actorId || !entityType || !actionType || !isObject(payload)) {
      return res.status(400).json({ error: "actorId, entityType, actionType, payload are required" });
    }
    if (!["person", "relationship"].includes(entityType)) {
      return res.status(400).json({ error: "entityType must be person or relationship" });
    }
    if (!["create", "update", "delete"].includes(actionType)) {
      return res.status(400).json({ error: "actionType must be create, update or delete" });
    }

    const actor = await db.get("SELECT id, is_admin FROM users WHERE id = ?", [actorId]);
    if (!actor) {
      return res.status(400).json({ error: "Utilisateur inconnu" });
    }

    if (actor.is_admin) {
      await db.exec("BEGIN IMMEDIATE TRANSACTION");
      try {
        const { newPersonId } = await mutateGenealogyChange(entityType, actionType, entityId, payload);
        const rowEntityId = entityType === "person" && actionType === "create" ? newPersonId : entityId;
        const ins = await db.run(
          `INSERT INTO change_requests (entity_type, action_type, entity_id, payload_json, status, requested_by, reviewed_by, reviewed_at)
           VALUES (?, ?, ?, ?, 'approved', ?, ?, CURRENT_TIMESTAMP)`,
          [entityType, actionType, rowEntityId, JSON.stringify(payload), actorId, actorId]
        );
        await db.exec("COMMIT");
        return res.status(201).json({ id: ins.lastID, appliedImmediately: true });
      } catch (err) {
        await db.exec("ROLLBACK");
        throw err;
      }
    }

    const result = await db.run(
      "INSERT INTO change_requests (entity_type, action_type, entity_id, payload_json, status, requested_by) VALUES (?, ?, ?, ?, 'pending', ?)",
      [entityType, actionType, entityId, JSON.stringify(payload), actorId]
    );
    res.status(201).json({ id: result.lastID, appliedImmediately: false });
  } catch (error) {
    next(error);
  }
});

const applyApprovedRequest = async (requestRow, adminId) => {
  const payload = JSON.parse(requestRow.payload_json || "{}");
  const { entity_type: entityType, action_type: actionType, entity_id: entityId } = requestRow;
  const { newPersonId } = await mutateGenealogyChange(entityType, actionType, entityId, payload);
  if (newPersonId != null) {
    await db.run("UPDATE change_requests SET entity_id = ? WHERE id = ?", [newPersonId, requestRow.id]);
  }
  await db.run(
    "UPDATE change_requests SET status = 'approved', reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?",
    [adminId, requestRow.id]
  );
};

app.post("/api/requests/:id/approve", async (req, res, next) => {
  try {
    const requestId = Number(req.params.id);
    const { adminId } = req.body;
    if (!adminId) return res.status(400).json({ error: "adminId is required" });

    await db.exec("BEGIN IMMEDIATE TRANSACTION");
    const adminRow = await db.get("SELECT id FROM users WHERE id = ? AND is_admin = 1", [adminId]);
    if (!adminRow) {
      await db.exec("ROLLBACK");
      return res.status(403).json({ error: "Only admin can approve requests" });
    }

    const requestRow = await db.get("SELECT * FROM change_requests WHERE id = ?", [requestId]);
    if (!requestRow) {
      await db.exec("ROLLBACK");
      return res.status(404).json({ error: "Request not found" });
    }
    if (requestRow.status !== "pending") {
      await db.exec("ROLLBACK");
      return res.status(409).json({ error: "Only pending requests can be approved" });
    }

    await applyApprovedRequest(requestRow, adminId);
    await db.exec("COMMIT");
    res.json({ success: true });
  } catch (error) {
    try {
      await db.exec("ROLLBACK");
    } catch {
      // no-op
    }
    next(error);
  }
});

app.post("/api/requests/:id/reject", async (req, res, next) => {
  try {
    const requestId = Number(req.params.id);
    const { adminId, reviewNote = null } = req.body;
    if (!adminId) return res.status(400).json({ error: "adminId is required" });

    const adminRow = await db.get("SELECT id FROM users WHERE id = ? AND is_admin = 1", [adminId]);
    if (!adminRow) return res.status(403).json({ error: "Only admin can reject requests" });

    const result = await db.run(
      "UPDATE change_requests SET status = 'rejected', reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP, review_note = ? WHERE id = ? AND status = 'pending'",
      [adminId, reviewNote, requestId]
    );
    if (result.changes === 0) return res.status(404).json({ error: "Pending request not found" });
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

const PORT = Number(process.env.PORT || 4000);
app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: error.message || "Internal server error" });
});

async function start() {
  db = await initDb();
  app.listen(PORT, () => {
    console.log(`API server listening on http://localhost:${PORT}`);
  });
}

start().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
