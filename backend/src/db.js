const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

async function initDb() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseServiceRoleKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  }

  const db = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  // Quick connectivity check.
  const { error: healthErr } = await db.from("users").select("id").limit(1);
  if (healthErr) throw healthErr;

  const ensureUser = async (name, isAdmin) => {
    const { data: existing, error: selErr } = await db.from("users").select("id").eq("name", name).limit(1);
    if (selErr) throw selErr;
    if (existing && existing.length) return;
    const { error: insErr } = await db.from("users").insert({ name, is_admin: isAdmin ? 1 : 0 });
    if (insErr) throw insErr;
  };

  await ensureUser("Admin", true);
  await ensureUser("Contributor", false);

  const defaultAdminPin = process.env.ADMIN_PIN || "admin";
  const { data: pinRow, error: pinSelErr } = await db.from("app_settings").select("key").eq("key", "admin_pin").maybeSingle();
  if (pinSelErr) throw pinSelErr;
  if (!pinRow) {
    const { error: pinInsErr } = await db.from("app_settings").insert({ key: "admin_pin", value: defaultAdminPin });
    if (pinInsErr) throw pinInsErr;
  }

  return db;
}

module.exports = { initDb };
