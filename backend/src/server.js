const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { initDb } = require("./db");

const app = express();
app.use(
  cors({
    origin: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"]
  })
);
app.use(express.json());

let dbInitPromise = null;
function ensureDbConnected() {
  if (!dbInitPromise) {
    dbInitPromise = initDb().then((client) => {
      db = client;
    });
  }
  return dbInitPromise;
}

app.use(async (_req, _res, next) => {
  try {
    await ensureDbConnected();
    next();
  } catch (err) {
    next(err);
  }
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype || !file.mimetype.startsWith("image/")) {
      cb(new Error("Only image files are allowed"));
      return;
    }
    cb(null, true);
  }
});

const isObject = (value) => value && typeof value === "object" && !Array.isArray(value);

function personIsDeceasedFlag(payload) {
  return payload.isDeceased === true || payload.isDeceased === 1 ? 1 : 0;
}

function personDeathDateOrNull(payload) {
  const d = payload.deathDate;
  if (d == null || d === "") return null;
  return String(d);
}

function mapPerson(row) {
  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    gender: row.gender,
    birthDate: row.birth_date,
    deathDate: row.death_date,
    isDeceased: Boolean(row.is_deceased),
    photoUrl: row.photo_url,
    notes: row.notes
  };
}

function mapRelationship(row) {
  return {
    id: row.id,
    sourcePersonId: row.source_person_id,
    targetPersonId: row.target_person_id,
    relationshipType: row.relationship_type
  };
}

let db;

app.get("/api/health", async (_req, res, next) => {
  try {
    const { error } = await db.from("users").select("id").limit(1);
    if (error) throw error;
    res.json({ healthy: true });
  } catch (error) {
    next(error);
  }
});

app.get("/api/users", async (_req, res, next) => {
  try {
    const { data, error } = await db.from("users").select("id,name,is_admin").order("is_admin", { ascending: false }).order("name", { ascending: true });
    if (error) throw error;
    res.json((data || []).map((u) => ({ id: u.id, name: u.name, isAdmin: Boolean(u.is_admin) })));
  } catch (error) {
    next(error);
  }
});

async function getStoredAdminPin() {
  const { data, error } = await db.from("app_settings").select("value").eq("key", "admin_pin").maybeSingle();
  if (error) throw error;
  if (data?.value) return data.value;
  return process.env.ADMIN_PIN || "admin";
}

app.post("/api/admin/verify-pin", async (req, res, next) => {
  try {
    const { pin } = req.body;
    if (typeof pin !== "string") return res.status(400).json({ error: "Code requis" });
    const stored = await getStoredAdminPin();
    if (pin !== stored) return res.status(401).json({ error: "Code administrateur incorrect" });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/admin/change-pin", async (req, res, next) => {
  try {
    const { currentPin, newPin } = req.body;
    if (typeof currentPin !== "string" || typeof newPin !== "string") return res.status(400).json({ error: "Codes requis" });
    if (newPin.length < 4) return res.status(400).json({ error: "Le nouveau code doit contenir au moins 4 caractères" });
    const stored = await getStoredAdminPin();
    if (currentPin !== stored) return res.status(401).json({ error: "Code actuel incorrect" });
    const { error } = await db.from("app_settings").upsert({ key: "admin_pin", value: newPin });
    if (error) throw error;
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/uploads", upload.single("image"), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Image file is required" });
    const bucket = process.env.SUPABASE_STORAGE_BUCKET || "people-photos";
    const ext = (req.file.originalname?.split(".").pop() || "jpg").toLowerCase();
    const key = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
    const { error } = await db.storage.from(bucket).upload(key, req.file.buffer, {
      contentType: req.file.mimetype || "image/jpeg",
      upsert: false
    });
    if (error) throw error;
    const { data } = db.storage.from(bucket).getPublicUrl(key);
    res.status(201).json({ url: data?.publicUrl || "" });
  } catch (error) {
    next(error);
  }
});

app.get("/api/tree", async (_req, res, next) => {
  try {
    const { data: peopleRows, error: pErr } = await db.from("people").select("*").is("deleted_at", null).order("id", { ascending: true });
    if (pErr) throw pErr;
    const { data: relRows, error: rErr } = await db.from("relationships").select("*").is("deleted_at", null).order("id", { ascending: true });
    if (rErr) throw rErr;
    res.json({
      people: (peopleRows || []).map(mapPerson),
      relationships: (relRows || []).map(mapRelationship)
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/requests", async (req, res, next) => {
  try {
    const status = req.query.status || "pending";
    const { data, error } = await db
      .from("change_requests")
      .select(
        "id,entity_type,action_type,entity_id,payload_json,status,review_note,created_at,requested_by,reviewed_by,requester:users!change_requests_requested_by_fkey(id,name),reviewer:users!change_requests_reviewed_by_fkey(name)"
      )
      .eq("status", status)
      .order("created_at", { ascending: true });
    if (error) throw error;
    const normalized = (data || []).map((row) => ({
      id: row.id,
      entityType: row.entity_type,
      actionType: row.action_type,
      entityId: row.entity_id,
      payloadJson: row.payload_json,
      status: row.status,
      reviewNote: row.review_note,
      createdAt: row.created_at,
      requesterId: row.requested_by,
      requesterName: row.requester?.name || "Inconnu",
      reviewerName: row.reviewer?.name || null,
      payload: JSON.parse(row.payload_json || "{}")
    }));
    res.json(normalized);
  } catch (error) {
    next(error);
  }
});

async function mutateGenealogyChange(entityType, actionType, entityId, payload) {
  if (entityType === "person" && actionType === "create") {
    const { data, error } = await db
      .from("people")
      .insert({
        first_name: payload.firstName,
        last_name: payload.lastName,
        gender: payload.gender || null,
        birth_date: payload.birthDate || null,
        death_date: personDeathDateOrNull(payload),
        is_deceased: personIsDeceasedFlag(payload),
        photo_url: payload.photoUrl || null,
        notes: payload.notes || null
      })
      .select("id")
      .single();
    if (error) throw error;
    return { newPersonId: data.id };
  }
  if (entityType === "person" && actionType === "update") {
    const { error } = await db
      .from("people")
      .update({
        first_name: payload.firstName,
        last_name: payload.lastName,
        gender: payload.gender || null,
        birth_date: payload.birthDate || null,
        death_date: personDeathDateOrNull(payload),
        is_deceased: personIsDeceasedFlag(payload),
        photo_url: payload.photoUrl || null,
        notes: payload.notes || null,
        updated_at: new Date().toISOString()
      })
      .eq("id", entityId)
      .is("deleted_at", null);
    if (error) throw error;
    return {};
  }
  if (entityType === "person" && actionType === "delete") {
    const now = new Date().toISOString();
    const { error: pErr } = await db.from("people").update({ deleted_at: now }).eq("id", entityId).is("deleted_at", null);
    if (pErr) throw pErr;
    const { error: rErr } = await db.from("relationships").update({ deleted_at: now }).or(`source_person_id.eq.${entityId},target_person_id.eq.${entityId}`).is("deleted_at", null);
    if (rErr) throw rErr;
    return {};
  }
  if (entityType === "relationship" && actionType === "create") {
    const { error } = await db.from("relationships").insert({
      source_person_id: payload.sourcePersonId,
      target_person_id: payload.targetPersonId,
      relationship_type: payload.relationshipType
    });
    if (error) throw error;
    return {};
  }
  if (entityType === "relationship" && actionType === "delete") {
    const { error } = await db.from("relationships").update({ deleted_at: new Date().toISOString() }).eq("id", entityId).is("deleted_at", null);
    if (error) throw error;
    return {};
  }
  throw new Error("Unsupported request type");
}

app.post("/api/requests", async (req, res, next) => {
  try {
    const { actorId, entityType, actionType, entityId = null, payload } = req.body;
    if (!actorId || !entityType || !actionType || !isObject(payload)) return res.status(400).json({ error: "actorId, entityType, actionType, payload are required" });
    if (!["person", "relationship"].includes(entityType)) return res.status(400).json({ error: "entityType must be person or relationship" });
    if (!["create", "update", "delete"].includes(actionType)) return res.status(400).json({ error: "actionType must be create, update or delete" });

    const { data: actor, error: aErr } = await db.from("users").select("id,is_admin").eq("id", actorId).maybeSingle();
    if (aErr) throw aErr;
    if (!actor) return res.status(400).json({ error: "Utilisateur inconnu" });

    const shouldApplyImmediately = true;
    if (shouldApplyImmediately) {
      const { newPersonId } = await mutateGenealogyChange(entityType, actionType, entityId, payload);
      const rowEntityId = entityType === "person" && actionType === "create" ? newPersonId : entityId;
      const insertPayload = actor.is_admin
        ? {
            entity_type: entityType,
            action_type: actionType,
            entity_id: rowEntityId,
            payload_json: JSON.stringify(payload),
            status: "approved",
            requested_by: actorId,
            reviewed_by: actorId,
            reviewed_at: new Date().toISOString()
          }
        : {
            entity_type: entityType,
            action_type: actionType,
            entity_id: rowEntityId,
            payload_json: JSON.stringify(payload),
            status: "approved",
            requested_by: actorId,
            reviewed_at: new Date().toISOString(),
            review_note: "Auto-approuvé"
          };
      const { data: reqRow, error: reqErr } = await db.from("change_requests").insert(insertPayload).select("id").single();
      if (reqErr) throw reqErr;
      return res.status(201).json({ id: reqRow.id, appliedImmediately: true });
    }

    const { data: row, error: pErr } = await db
      .from("change_requests")
      .insert({
        entity_type: entityType,
        action_type: actionType,
        entity_id: entityId,
        payload_json: JSON.stringify(payload),
        status: "pending",
        requested_by: actorId
      })
      .select("id")
      .single();
    if (pErr) throw pErr;
    res.status(201).json({ id: row.id, appliedImmediately: false });
  } catch (error) {
    next(error);
  }
});

const applyApprovedRequest = async (requestRow, adminId) => {
  const payload = JSON.parse(requestRow.payload_json || "{}");
  const { newPersonId } = await mutateGenealogyChange(requestRow.entity_type, requestRow.action_type, requestRow.entity_id, payload);
  const updates = {
    status: "approved",
    reviewed_by: adminId,
    reviewed_at: new Date().toISOString()
  };
  if (newPersonId != null) updates.entity_id = newPersonId;
  const { error } = await db.from("change_requests").update(updates).eq("id", requestRow.id);
  if (error) throw error;
};

app.post("/api/requests/:id/approve", async (req, res, next) => {
  try {
    const requestId = Number(req.params.id);
    const { adminId } = req.body;
    if (!adminId) return res.status(400).json({ error: "adminId is required" });

    const { data: adminRow, error: adErr } = await db.from("users").select("id").eq("id", adminId).eq("is_admin", 1).maybeSingle();
    if (adErr) throw adErr;
    if (!adminRow) return res.status(403).json({ error: "Only admin can approve requests" });

    const { data: requestRow, error: rErr } = await db.from("change_requests").select("*").eq("id", requestId).maybeSingle();
    if (rErr) throw rErr;
    if (!requestRow) return res.status(404).json({ error: "Request not found" });
    if (requestRow.status !== "pending") return res.status(409).json({ error: "Only pending requests can be approved" });

    await applyApprovedRequest(requestRow, adminId);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/requests/:id/reject", async (req, res, next) => {
  try {
    const requestId = Number(req.params.id);
    const { adminId, reviewNote = null } = req.body;
    if (!adminId) return res.status(400).json({ error: "adminId is required" });
    const { data: adminRow, error: adErr } = await db.from("users").select("id").eq("id", adminId).eq("is_admin", 1).maybeSingle();
    if (adErr) throw adErr;
    if (!adminRow) return res.status(403).json({ error: "Only admin can reject requests" });

    const { data, error } = await db
      .from("change_requests")
      .update({
        status: "rejected",
        reviewed_by: adminId,
        reviewed_at: new Date().toISOString(),
        review_note: reviewNote
      })
      .eq("id", requestId)
      .eq("status", "pending")
      .select("id");
    if (error) throw error;
    if (!data || data.length === 0) return res.status(404).json({ error: "Pending request not found" });
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
  await ensureDbConnected();
  app.listen(PORT, () => {
    console.log(`API server listening on http://localhost:${PORT}`);
  });
}

module.exports = app;

if (require.main === module && !process.env.VERCEL) {
  start().catch((error) => {
    console.error("Failed to start server:", error);
    process.exit(1);
  });
}
