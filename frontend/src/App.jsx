import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import axios from "axios";

function normalizeApiOrigin(value) {
  if (value == null || typeof value !== "string") return "";
  const t = value.trim();
  if (!t) return "";
  return t.replace(/\/+$/, "");
}

const envApiOrigin =
  typeof import.meta !== "undefined" && import.meta.env && import.meta.env.VITE_API_ORIGIN
    ? String(import.meta.env.VITE_API_ORIGIN)
    : "";

const localApiOrigin =
  typeof window !== "undefined" &&
  (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")
    ? `${window.location.protocol}//${window.location.hostname}:4000`
    : "";

const API_ORIGIN = normalizeApiOrigin(envApiOrigin || localApiOrigin);
const api = axios.create({ baseURL: API_ORIGIN ? `${API_ORIGIN}/api` : "/api" });

const ADMIN_SESSION_KEY = "genealogyAdminSession";

const EMPTY_PERSON_FORM = {
  firstName: "",
  lastName: "",
  gender: "other",
  birthDate: "",
  deathDate: "",
  isDeceased: false,
  photoUrl: "",
  notes: ""
};

function idContributeur(users) {
  const u = users.find((x) => !x.isAdmin);
  return u?.id ?? users[0]?.id ?? 0;
}

function idAdministrateur(users) {
  return users.find((x) => x.isAdmin)?.id ?? 0;
}

/** Ancestors along parent_child edges (child → parents, recursively). */
function collectAncestorPersonIds(personId, parentMap) {
  const out = new Set();
  const queue = [...(parentMap.get(personId) ?? [])];
  while (queue.length > 0) {
    const cur = queue.shift();
    if (out.has(cur)) continue;
    out.add(cur);
    for (const p of parentMap.get(cur) ?? []) queue.push(p);
  }
  return out;
}

/** Descendants along parent_child edges (parent → children, recursively). */
function collectDescendantPersonIds(personId, childMap) {
  const out = new Set();
  const queue = [...(childMap.get(personId) ?? [])];
  while (queue.length > 0) {
    const cur = queue.shift();
    if (out.has(cur)) continue;
    out.add(cur);
    for (const k of childMap.get(cur) ?? []) queue.push(k);
  }
  return out;
}

/** Bloodline component through parent_child edges (parents/children/siblings/cousins...), including self. */
function collectBloodlinePersonIds(personId, parentMap, childMap) {
  if (!personId) return new Set();
  const out = new Set();
  const queue = [personId];
  while (queue.length > 0) {
    const cur = queue.shift();
    if (out.has(cur)) continue;
    out.add(cur);
    for (const p of parentMap.get(cur) ?? []) if (!out.has(p)) queue.push(p);
    for (const c of childMap.get(cur) ?? []) if (!out.has(c)) queue.push(c);
  }
  return out;
}

/** Blood relation test: true if two people share at least one ancestor (or are the same person). */
function hasSharedAncestorOrSelf(aId, bId, parentMap) {
  if (!aId || !bId) return false;
  if (aId === bId) return true;
  const aAnc = collectAncestorPersonIds(aId, parentMap);
  const bAnc = collectAncestorPersonIds(bId, parentMap);
  // Include self so parent-child and direct same-line relations are caught.
  aAnc.add(aId);
  bAnc.add(bId);
  for (const id of aAnc) {
    if (bAnc.has(id)) return true;
  }
  return false;
}

/** Default Parent 2: first linked partner (stable order by person id if several). */
function firstLinkedPartnerId(parent1Id, partnerMap) {
  if (!parent1Id) return 0;
  const ids = partnerMap.get(parent1Id) ?? [];
  if (ids.length === 0) return 0;
  return [...ids].sort((a, b) => a - b)[0];
}

/** Cannot be the other co-parent: self, own ancestors, or own descendants (avoids picking e.g. parents as Parent 2). */
function forbiddenCoParentIds(personId, parentMap, childMap) {
  if (!personId) return new Set();
  const s = new Set([personId]);
  collectAncestorPersonIds(personId, parentMap).forEach((id) => s.add(id));
  collectDescendantPersonIds(personId, childMap).forEach((id) => s.add(id));
  return s;
}

/** Same-generation siblings (any shared parent): not valid as the other parent when adding a child. */
function siblingPersonIds(personId, parentMap, childMap) {
  if (!personId) return new Set();
  const out = new Set();
  for (const pId of parentMap.get(personId) ?? []) {
    for (const cid of childMap.get(pId) ?? []) {
      if (cid !== personId) out.add(cid);
    }
  }
  return out;
}

/**
 * No parent in the tree, but only linked as partner to people who have parents — not a “founder” row on the main tree
 * (typical case: spouse added from a child branch). Still shown next to their partner in branch view / partner line.
 */
function isSpouseOnlyAttachedToTree(personId, rootPersonIdSet, partnerMap) {
  if (!rootPersonIdSet.has(personId)) return false;
  const partners = partnerMap.get(personId) ?? [];
  if (partners.length === 0) return false;
  return !partners.some((pid) => rootPersonIdSet.has(pid));
}

function parseCalendarDate(iso) {
  if (!iso) return null;
  const s = String(iso).slice(0, 10);
  const parts = s.split("-");
  if (parts.length !== 3) return null;
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  if (!y || !m || !d) return null;
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return dt;
}

function ageInYearsBetween(fromDate, toDate) {
  let years = toDate.getFullYear() - fromDate.getFullYear();
  const monthDiff = toDate.getMonth() - fromDate.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && toDate.getDate() < fromDate.getDate())) years--;
  return Math.max(0, years);
}

/** { years, ageAtDeath } or null if birth unknown or deceased without death date. */
function personAgeInfo(person) {
  if (!person) return null;
  const birth = parseCalendarDate(person.birthDate);
  if (!birth) return null;
  let end;
  if (person.isDeceased) {
    if (!person.deathDate) return null;
    end = parseCalendarDate(person.deathDate);
  } else {
    const n = new Date();
    end = new Date(n.getFullYear(), n.getMonth(), n.getDate());
  }
  if (!end) return null;
  const years = ageInYearsBetween(birth, end);
  return { years, ageAtDeath: Boolean(person.isDeceased && person.deathDate) };
}

function normalizeForFamilySearch(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
}

function resolvePhotoUrl(photoUrl) {
  if (!photoUrl) return "";
  if (/^https?:\/\//i.test(photoUrl)) return photoUrl;
  if (photoUrl.startsWith("/")) return `${API_ORIGIN}${photoUrl}`;
  return photoUrl;
}

const MONTHS_FR_LONG = [
  "janvier",
  "février",
  "mars",
  "avril",
  "mai",
  "juin",
  "juillet",
  "août",
  "septembre",
  "octobre",
  "novembre",
  "décembre"
];

function formatLongFrenchDate(iso) {
  const d = parseCalendarDate(iso);
  if (!d) return "";
  const day = d.getDate();
  const dayLabel = day === 1 ? "1er" : String(day);
  return `${dayLabel} ${MONTHS_FR_LONG[d.getMonth()]} ${d.getFullYear()}`;
}

function deathCalendarYear(iso) {
  const d = parseCalendarDate(iso);
  return d ? d.getFullYear() : null;
}

function countGrandchildren(personId, childMap) {
  let n = 0;
  for (const cid of childMap.get(personId) ?? []) n += (childMap.get(cid) ?? []).length;
  return n;
}

function countGreatGrandchildren(personId, childMap) {
  let n = 0;
  for (const cid of childMap.get(personId) ?? []) {
    for (const gcid of childMap.get(cid) ?? []) n += (childMap.get(gcid) ?? []).length;
  }
  return n;
}

function joinFrenchAnd(items) {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} et ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} et ${items[items.length - 1]}`;
}

function Modal({ title, children, onClose, footer, panelClassName = "", closeDisabled = false }) {
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onClick={(e) => {
        if (closeDisabled) return;
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={`modal-panel${panelClassName ? ` ${panelClassName}` : ""}`} role="dialog" aria-modal="true" aria-labelledby="modal-title" aria-busy={closeDisabled || undefined}>
        <div className="modal-header">
          <h2 id="modal-title">{title}</h2>
          <button type="button" className="modal-close" onClick={onClose} disabled={closeDisabled} aria-label="Fermer">
            ×
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

function BtnSubmitContents({ loading, children }) {
  if (!loading) return children;
  return (
    <span className="btn-submit-inner">
      <span className="btn-spinner" aria-hidden />
      <span>En cours…</span>
    </span>
  );
}

function IconPlus() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function IconTrash() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="M3 6h18M8 6V4h8v2M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M10 11v6M14 11v6" />
    </svg>
  );
}

function IconLink() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M10 13a5 5 0 0 1 0-7l1-1a5 5 0 0 1 7 7l-1 1M14 11a5 5 0 0 1 0 7l-1 1a5 5 0 0 1-7-7l1-1" />
    </svg>
  );
}

function IconChild() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M12 3v18M8 8h8M8 16h8" />
    </svg>
  );
}

/** Ouvrir la vue « cette personne comme parent » (branche / génération suivante). */
function IconBranchFocus() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="5" r="2.5" />
      <circle cx="6" cy="19" r="2.5" />
      <circle cx="18" cy="19" r="2.5" />
      <path d="M12 7.5v3.5a2.5 2.5 0 0 1-2.5 2.5H8.5M12 7.5a2.5 2.5 0 0 1 2.5 2.5V11" />
    </svg>
  );
}

function IconBell() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}

function IconEyeOpen() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
      <path d="M15 12a3 3 0 11-6 0 3 3 0 0 1 6 0z" />
    </svg>
  );
}

function IconEyeClosed() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3.98 8.223A10.477 10.477 0 0 0 1.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0 1 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639M6.228 6.228L3 3m3.228 3.228 3.65 3.65m7.894 7.894L21 21m-3.228-3.228-3.65-3.65m0 0a3 3 0 1 0-4.243-4.243m4.242 4.242L9.88 9.88" />
    </svg>
  );
}

function IconMsgSuccess() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="10" />
      <path d="m8.5 12.5 2.2 2.2 4.8-5.3" />
    </svg>
  );
}

function IconMsgError() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 8v4M12 16h.01" />
    </svg>
  );
}

function IconMsgInfo() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4M12 8h.01" />
    </svg>
  );
}

function MessageIcon({ variant }) {
  if (variant === "success") return <IconMsgSuccess />;
  if (variant === "error") return <IconMsgError />;
  return <IconMsgInfo />;
}

function PinField({ label, id, autoComplete, placeholder, value, onChange, visible, onToggle }) {
  return (
    <>
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <div className="password-field-wrap">
        <input id={id} type={visible ? "text" : "password"} autoComplete={autoComplete} value={value} onChange={onChange} placeholder={placeholder} />
        <button type="button" className="password-toggle" onClick={onToggle} aria-label={visible ? "Masquer le code" : "Afficher le code"} aria-pressed={visible}>
          {visible ? <IconEyeClosed /> : <IconEyeOpen />}
        </button>
      </div>
    </>
  );
}

function App() {
  const [users, setUsers] = useState([]);
  const [activeUserId, setActiveUserId] = useState(0);
  const [people, setPeople] = useState([]);
  const [relationships, setRelationships] = useState([]);
  const [pendingRequests, setPendingRequests] = useState([]);
  const [toast, setToast] = useState(null);
  const [toastOpen, setToastOpen] = useState(false);

  function setMessage(text, variant = "info") {
    if (text === "" || text == null) {
      setToastOpen(false);
      return;
    }
    setToast((prev) => (prev ? { ...prev, text, variant } : { id: Date.now(), text, variant }));
  }

  useLayoutEffect(() => {
    if (!toast) {
      setToastOpen(false);
      return undefined;
    }
    setToastOpen(false);
    const frame = requestAnimationFrame(() => {
      requestAnimationFrame(() => setToastOpen(true));
    });
    return () => cancelAnimationFrame(frame);
  }, [toast?.id]);

  useEffect(() => {
    if (!toast || !toastOpen) return undefined;
    const id = setTimeout(() => setToastOpen(false), 5200);
    return () => clearTimeout(id);
  }, [toast, toastOpen]);

  function handleToastTransitionEnd(e) {
    if (e.target !== e.currentTarget) return;
    if (e.propertyName !== "opacity") return;
    if (!toastOpen) setToast(null);
  }

  const [modal, setModal] = useState(null);
  const [adminPinDraft, setAdminPinDraft] = useState("");
  const [showAdminPin, setShowAdminPin] = useState(false);
  const [changePin, setChangePin] = useState({ current: "", next: "", confirm: "" });
  const [showChangePinFields, setShowChangePinFields] = useState({ current: false, next: false, confirm: false });
  const [adminLoginError, setAdminLoginError] = useState("");
  const [changePinError, setChangePinError] = useState("");

  const [newPerson, setNewPerson] = useState(() => ({ ...EMPTY_PERSON_FORM }));
  const [newPhotoUploading, setNewPhotoUploading] = useState(false);
  const [editPersonId, setEditPersonId] = useState(0);
  const [editPerson, setEditPerson] = useState(() => ({ ...EMPTY_PERSON_FORM }));
  const [editPhotoUploading, setEditPhotoUploading] = useState(false);
  const [deletePersonId, setDeletePersonId] = useState(0);
  const [partnerA, setPartnerA] = useState(0);
  const [partnerB, setPartnerB] = useState(0);
  const [partnerAnchorId, setPartnerAnchorId] = useState(0);
  const [parent1Id, setParent1Id] = useState(0);
  const [parent2Id, setParent2Id] = useState(0);
  const [childId, setChildId] = useState(0);
  const [childAnchorParentId, setChildAnchorParentId] = useState(0);
  /** Pile de navigation : afficher la branche centrée sur la dernière personne ; [] = arbre complet. */
  const [familyBranchStack, setFamilyBranchStack] = useState([]);
  const [familySearchQuery, setFamilySearchQuery] = useState("");
  const treeSearchRef = useRef(null);
  const [detailsPersonId, setDetailsPersonId] = useState(0);
  const [photoPreview, setPhotoPreview] = useState(null);
  const [modalSubmitting, setModalSubmitting] = useState(false);
  const [pendingAction, setPendingAction] = useState(null);

  const activeUser = users.find((u) => u.id === activeUserId) || null;
  const isAdmin = Boolean(activeUser?.isAdmin);
  const saveOrRequestLabel = "Enregistrer";

  const peopleById = useMemo(() => Object.fromEntries(people.map((p) => [p.id, p])), [people]);

  /** Unique child ids per parent (DB may contain duplicate parent_child rows). */
  const childMap = useMemo(() => {
    const map = new Map();
    relationships
      .filter((r) => r.relationshipType === "parent_child")
      .forEach((r) => {
        const set = map.get(r.sourcePersonId) ?? new Set();
        set.add(r.targetPersonId);
        map.set(r.sourcePersonId, set);
      });
    const out = new Map();
    map.forEach((set, pid) => out.set(pid, [...set]));
    return out;
  }, [relationships]);

  /** Unique parent ids per child (same dedup as childMap). */
  const parentMap = useMemo(() => {
    const map = new Map();
    relationships
      .filter((r) => r.relationshipType === "parent_child")
      .forEach((r) => {
        const set = map.get(r.targetPersonId) ?? new Set();
        set.add(r.sourcePersonId);
        map.set(r.targetPersonId, set);
      });
    const out = new Map();
    map.forEach((set, pid) => out.set(pid, [...set]));
    return out;
  }, [relationships]);

  /** Parent 2/1 exclusions: blood relatives (shared ancestors), but not spouse-through-child loops. */
  const excludedForSecondParent = useMemo(() => {
    const baseParent1 = childAnchorParentId || parent1Id;
    if (!baseParent1) return new Set();
    const s = new Set();
    people.forEach((p) => {
      if (hasSharedAncestorOrSelf(baseParent1, p.id, parentMap)) s.add(p.id);
    });
    return s;
  }, [childAnchorParentId, parent1Id, parentMap, people]);

  const excludedForFirstParent = useMemo(() => {
    if (!parent2Id) return new Set();
    const s = new Set();
    people.forEach((p) => {
      if (hasSharedAncestorOrSelf(parent2Id, p.id, parentMap)) s.add(p.id);
    });
    return s;
  }, [parent2Id, parentMap, people]);

  const partnerMap = useMemo(() => {
    const map = new Map();
    relationships
      .filter((r) => r.relationshipType === "partner")
      .forEach((r) => {
        map.set(r.sourcePersonId, [...(map.get(r.sourcePersonId) ?? []), r.targetPersonId]);
        map.set(r.targetPersonId, [...(map.get(r.targetPersonId) ?? []), r.sourcePersonId]);
      });
    return map;
  }, [relationships]);

  const effectivePartnerAId = partnerAnchorId || partnerA;
  const excludedPartnerBIds = useMemo(() => collectBloodlinePersonIds(effectivePartnerAId, parentMap, childMap), [effectivePartnerAId, parentMap, childMap]);
  const excludedPartnerAIds = useMemo(() => {
    if (partnerAnchorId) {
      const s = new Set();
      people.forEach((p) => {
        if (p.id !== partnerAnchorId) s.add(p.id);
      });
      return s;
    }
    return collectBloodlinePersonIds(partnerB, parentMap, childMap);
  }, [partnerAnchorId, partnerB, parentMap, childMap, people]);

  const rootPersonIdSet = useMemo(() => {
    const childIds = new Set(relationships.filter((r) => r.relationshipType === "parent_child").map((r) => r.targetPersonId));
    return new Set(people.map((p) => p.id).filter((id) => !childIds.has(id)));
  }, [people, relationships]);

  const mainTreeRootIds = useMemo(() => [...rootPersonIdSet].filter((id) => !isSpouseOnlyAttachedToTree(id, rootPersonIdSet, partnerMap)), [rootPersonIdSet, partnerMap]);

  /** Cannot be “enfant”: ancestors, partners, or siblings of either parent (a parent cannot adopt their sibling as child). */
  const excludedAsChildBranch = useMemo(() => {
    const s = new Set();
    if (parent1Id) {
      collectAncestorPersonIds(parent1Id, parentMap).forEach((id) => s.add(id));
      (partnerMap.get(parent1Id) ?? []).forEach((id) => s.add(id));
      siblingPersonIds(parent1Id, parentMap, childMap).forEach((id) => s.add(id));
    }
    if (parent2Id) {
      collectAncestorPersonIds(parent2Id, parentMap).forEach((id) => s.add(id));
      (partnerMap.get(parent2Id) ?? []).forEach((id) => s.add(id));
      siblingPersonIds(parent2Id, parentMap, childMap).forEach((id) => s.add(id));
    }
    return s;
  }, [parent1Id, parent2Id, parentMap, childMap, partnerMap]);

  /** People who can be chosen as child:
   *  - not Parent 1 / Parent 2
   *  - not ancestors/partners/siblings of either parent
   *  - not already linked as child to any parent ("enfant libre" only)
   */
  const childBranchCandidates = useMemo(
    () =>
      people.filter(
        (p) =>
          p.id !== parent1Id &&
          p.id !== parent2Id &&
          !excludedAsChildBranch.has(p.id) &&
          (parentMap.get(p.id) ?? []).length === 0
      ),
    [people, parent1Id, parent2Id, excludedAsChildBranch, parentMap]
  );

  useEffect(() => {
    if (!childId) return;
    if (!childBranchCandidates.some((p) => p.id === childId)) setChildId(0);
  }, [childBranchCandidates, childId]);

  useEffect(() => {
    if (!parent2Id) return;
    if (excludedForSecondParent.has(parent2Id)) setParent2Id(0);
  }, [excludedForSecondParent, parent2Id]);

  useEffect(() => {
    if (!parent1Id) return;
    if (excludedForFirstParent.has(parent1Id)) setParent1Id(0);
  }, [excludedForFirstParent, parent1Id]);

  useEffect(() => {
    if (!partnerB) return;
    if (excludedPartnerBIds.has(partnerB)) setPartnerB(0);
  }, [excludedPartnerBIds, partnerB]);

  useEffect(() => {
    if (!partnerA) return;
    if (excludedPartnerAIds.has(partnerA)) setPartnerA(0);
  }, [excludedPartnerAIds, partnerA]);

  useEffect(() => {
    if (!partnerAnchorId) return;
    if (partnerA !== partnerAnchorId) setPartnerA(partnerAnchorId);
  }, [partnerAnchorId, partnerA]);

  const generationRows = useMemo(() => {
    if (!people.length) return [];
    const levels = new Map();
    const queue = [];
    mainTreeRootIds.forEach((id) => {
      levels.set(id, 0);
      queue.push(id);
    });

    while (queue.length > 0) {
      const current = queue.shift();
      const nextLevel = (levels.get(current) ?? 0) + 1;
      const children = childMap.get(current) ?? [];
      children.forEach((cid) => {
        const existing = levels.get(cid);
        if (existing === undefined || nextLevel < existing) {
          levels.set(cid, nextLevel);
          queue.push(cid);
        }
      });
    }

    people.forEach((person) => {
      if (levels.has(person.id)) return;
      if (isSpouseOnlyAttachedToTree(person.id, rootPersonIdSet, partnerMap)) return;
      levels.set(person.id, 0);
    });

    if (levels.size === 0) return [];

    const maxLevel = Math.max(...levels.values());
    const rows = Array.from({ length: maxLevel + 1 }, () => []);
    levels.forEach((level, personId) => rows[level].push(personId));
    rows.forEach((row) => row.sort((a, b) => a - b));
    return rows;
  }, [people, childMap, mainTreeRootIds, rootPersonIdSet, partnerMap]);

  const visibleGenerationRows = useMemo(() => generationRows.slice(0, 2), [generationRows]);
  const collapsedGenerationRows = useMemo(() => generationRows.slice(2), [generationRows]);
  const collapsedDescendantsCount = useMemo(
    () => collapsedGenerationRows.reduce((sum, row) => sum + row.length, 0),
    [collapsedGenerationRows]
  );

  async function loadAll() {
    const [usersRes, treeRes, requestRes] = await Promise.all([api.get("/users"), api.get("/tree"), api.get("/requests?status=pending")]);
    setUsers(usersRes.data);
    setPeople(treeRes.data.people);
    setRelationships(treeRes.data.relationships);
    setPendingRequests(requestRes.data);
  }

  useEffect(() => {
    loadAll().catch((error) => setMessage(error.response?.data?.error || error.message, "error"));
  }, []);

  useEffect(() => {
    if (!users.length) return;
    const enAdmin = sessionStorage.getItem(ADMIN_SESSION_KEY) === "true";
    const adminId = idAdministrateur(users);
    const contribId = idContributeur(users);
    const id = enAdmin && adminId ? adminId : contribId;
    if (id) setActiveUserId(id);
  }, [users]);

  useEffect(() => {
    setFamilyBranchStack((stack) => {
      const next = stack.filter((id) => people.some((p) => p.id === id));
      return next.length === stack.length ? stack : next;
    });
  }, [people]);

  useEffect(() => {
    if (familyBranchStack.length > 0) setFamilySearchQuery("");
  }, [familyBranchStack.length]);

  const familySearchTrimmed = familySearchQuery.trim();
  const familySearchMatches = useMemo(() => {
    if (!familySearchTrimmed) return [];
    const q = normalizeForFamilySearch(familySearchTrimmed);
    return people
      .filter((p) => normalizeForFamilySearch(`${p.firstName} ${p.lastName}`).includes(q))
      .sort((a, b) => `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`, "fr", { sensitivity: "base" }))
      .slice(0, 30);
  }, [people, familySearchTrimmed]);

  useEffect(() => {
    if (!familySearchTrimmed) return undefined;
    function onPointerDown(e) {
      if (treeSearchRef.current && !treeSearchRef.current.contains(e.target)) setFamilySearchQuery("");
    }
    function onKeyDown(e) {
      if (e.key === "Escape") setFamilySearchQuery("");
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [familySearchTrimmed]);

  useEffect(() => {
    const person = people.find((p) => p.id === editPersonId);
    if (!person) return;
    setEditPerson({
      firstName: person.firstName,
      lastName: person.lastName,
      gender: person.gender ?? "other",
      birthDate: person.birthDate ?? "",
      deathDate: person.deathDate ?? "",
      isDeceased: Boolean(person.isDeceased),
      photoUrl: person.photoUrl ?? "",
      notes: person.notes ?? ""
    });
  }, [editPersonId, people]);

  function closeModal() {
    setModalSubmitting(false);
    setPendingAction(null);
    setModal(null);
  }

  function openPhotoPreview(photoUrl, personName) {
    const resolved = resolvePhotoUrl(photoUrl);
    if (!resolved) return;
    setPhotoPreview({ url: resolved, name: personName || "Photo" });
  }

  function closePhotoPreview() {
    setPhotoPreview(null);
  }

  async function connecterAdmin(e) {
    e.preventDefault();
    const adminId = idAdministrateur(users);
    if (!adminId) {
      setAdminLoginError("Aucun compte administrateur trouvé.");
      return;
    }
    setModalSubmitting(true);
    try {
      await api.post("/admin/verify-pin", { pin: adminPinDraft });
      sessionStorage.setItem(ADMIN_SESSION_KEY, "true");
      setActiveUserId(adminId);
      setAdminPinDraft("");
      setShowAdminPin(false);
      setAdminLoginError("");
      closeModal();
      setMessage("Vous êtes connecté en tant qu'administrateur.", "success");
    } catch (err) {
      setAdminLoginError(err.response?.data?.error || "Code administrateur incorrect.");
    } finally {
      setModalSubmitting(false);
    }
  }

  async function soumettreChangementCode(e) {
    e.preventDefault();
    if (changePin.next !== changePin.confirm) {
      setChangePinError("La confirmation ne correspond pas au nouveau code.");
      return;
    }
    setModalSubmitting(true);
    try {
      await api.post("/admin/change-pin", { currentPin: changePin.current, newPin: changePin.next });
      setChangePin({ current: "", next: "", confirm: "" });
      setShowChangePinFields({ current: false, next: false, confirm: false });
      setChangePinError("");
      closeModal();
      setMessage("Code administrateur mis à jour.", "success");
    } catch (err) {
      const msg = err.response?.data?.error || err.message || "Une erreur s'est produite.";
      setChangePinError(msg);
    } finally {
      setModalSubmitting(false);
    }
  }

  function quitterAdmin() {
    sessionStorage.removeItem(ADMIN_SESSION_KEY);
    const cid = idContributeur(users);
    if (cid) setActiveUserId(cid);
    setMessage("Vous êtes de retour en mode famille.", "info");
  }

  async function uploadPersonPhoto(file) {
    const fd = new FormData();
    fd.append("image", file);
    const { data } = await api.post("/uploads", fd, {
      headers: { "Content-Type": "multipart/form-data" }
    });
    return data.url || "";
  }

  async function submitRequest(entityType, actionType, entityId, payload) {
    if (!activeUserId) return setMessage("Chargement en cours…", "info");
    const { data } = await api.post("/requests", { actorId: activeUserId, entityType, actionType, entityId, payload });
    setMessage(data.appliedImmediately ? "Modification enregistrée." : "Demande envoyée — en attente de validation par un administrateur.", "success");
    await loadAll();
  }

  async function approveRequest(requestId) {
    if (!activeUserId || pendingAction) return;
    setPendingAction({ id: requestId, kind: "approve" });
    try {
      await api.post(`/requests/${requestId}/approve`, { adminId: activeUserId });
      await loadAll();
    } catch (err) {
      setMessage(err.response?.data?.error || err.message, "error");
    } finally {
      setPendingAction(null);
    }
  }

  async function rejectRequest(requestId) {
    if (!activeUserId || pendingAction) return;
    setPendingAction({ id: requestId, kind: "reject" });
    try {
      await api.post(`/requests/${requestId}/reject`, { adminId: activeUserId, reviewNote: "Refusé depuis l'application." });
      await loadAll();
    } catch (err) {
      setMessage(err.response?.data?.error || err.message, "error");
    } finally {
      setPendingAction(null);
    }
  }

  function fullName(person) {
    if (!person) return "Inconnu";
    return `${person.firstName} ${person.lastName}`;
  }

  function initials(person) {
    return `${person.firstName.slice(0, 1)}${person.lastName.slice(0, 1)}`.toUpperCase();
  }

  function genreAffiche(g) {
    if (g === "male") return "Homme";
    if (g === "female") return "Femme";
    if (g === "other") return "Autre";
    return "—";
  }

  function formatDisplayDate(iso) {
    if (!iso) return "";
    const parts = String(iso).slice(0, 10).split("-");
    if (parts.length !== 3) return iso;
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
  }

  function isPersonDeceased(p) {
    return Boolean(p?.isDeceased);
  }

  function deceasedMarkText(gender) {
    if (gender === "female") return "(décédée)";
    if (gender === "male") return "(décédé)";
    return "(décédé·e)";
  }

  function deceasedTitleText(gender, deathDate) {
    const adj = gender === "female" ? "Décédée" : gender === "male" ? "Décédé" : "Décédé·e";
    if (deathDate) return `${adj} le ${formatDisplayDate(deathDate)}`;
    return adj;
  }

  function birthTitlePhrase(person) {
    const p = person.gender === "female" ? "Née le" : person.gender === "male" ? "Né le" : "Né(e) le";
    return `${p} ${formatDisplayDate(person.birthDate)}`;
  }

  function personAgeTitle(person, info) {
    if (!info) return undefined;
    if (info.ageAtDeath) return `Âge au décès : ${info.years} ans — ${birthTitlePhrase(person)} — Décès le ${formatDisplayDate(person.deathDate)}`;
    return birthTitlePhrase(person);
  }

  async function handleAddPersonSubmit(e) {
    e.preventDefault();
    if (modalSubmitting) return;
    setModalSubmitting(true);
    try {
      await submitRequest("person", "create", null, newPerson);
      setNewPerson({ ...EMPTY_PERSON_FORM });
      closeModal();
    } catch (err) {
      setMessage(err.response?.data?.error || err.message, "error");
    } finally {
      setModalSubmitting(false);
    }
  }

  async function handleEditPersonSubmit(e) {
    e.preventDefault();
    if (modalSubmitting) return;
    setModalSubmitting(true);
    try {
      await submitRequest("person", "update", editPersonId, editPerson);
      setEditPersonId(0);
      setEditPerson({ ...EMPTY_PERSON_FORM });
      closeModal();
    } catch (err) {
      setMessage(err.response?.data?.error || err.message, "error");
    } finally {
      setModalSubmitting(false);
    }
  }

  async function handleDeletePersonConfirm(e) {
    e.preventDefault();
    if (modalSubmitting) return;
    setModalSubmitting(true);
    try {
      await submitRequest("person", "delete", deletePersonId, {});
      setDeletePersonId(0);
      closeModal();
    } catch (err) {
      setMessage(err.response?.data?.error || err.message, "error");
    } finally {
      setModalSubmitting(false);
    }
  }

  async function handlePartnerSubmit(e) {
    e.preventDefault();
    if (modalSubmitting) return;
    setModalSubmitting(true);
    try {
      await submitRequest("relationship", "create", null, { sourcePersonId: partnerA, targetPersonId: partnerB, relationshipType: "partner" });
      setPartnerA(0);
      setPartnerB(0);
      setPartnerAnchorId(0);
      closeModal();
    } catch (err) {
      setMessage(err.response?.data?.error || err.message, "error");
    } finally {
      setModalSubmitting(false);
    }
  }

  async function handleChildBranchSubmit(e) {
    e.preventDefault();
    if (modalSubmitting) return;
    if (!activeUserId) {
      setMessage("Chargement en cours…", "info");
      return;
    }
    setModalSubmitting(true);
    try {
      const { data: d1 } = await api.post("/requests", {
        actorId: activeUserId,
        entityType: "relationship",
        actionType: "create",
        entityId: null,
        payload: { sourcePersonId: parent1Id, targetPersonId: childId, relationshipType: "parent_child" }
      });
      let appliedImmediately = Boolean(d1.appliedImmediately);
      if (parent2Id) {
        const { data: d2 } = await api.post("/requests", {
          actorId: activeUserId,
          entityType: "relationship",
          actionType: "create",
          entityId: null,
          payload: { sourcePersonId: parent2Id, targetPersonId: childId, relationshipType: "parent_child" }
        });
        appliedImmediately = appliedImmediately && Boolean(d2.appliedImmediately);
      }
      setMessage(appliedImmediately ? "Modification enregistrée." : "Demande envoyée — en attente de validation par un administrateur.", "success");
      setParent1Id(0);
      setParent2Id(0);
      setChildId(0);
      setChildAnchorParentId(0);
      closeModal();
      await loadAll();
    } catch (err) {
      setMessage(err.response?.data?.error || err.message, "error");
    } finally {
      setModalSubmitting(false);
    }
  }

  function openAddModal() {
    setNewPerson({ ...EMPTY_PERSON_FORM });
    setModal("add");
  }

  function openEditModal(person) {
    setEditPersonId(person.id);
    setModal("edit");
  }

  function openPersonDetails(person) {
    setDetailsPersonId(person.id);
    setModal("details");
  }

  function closePersonDetails() {
    setDetailsPersonId(0);
    closeModal();
  }

  function openEditFromDetails(person) {
    setDetailsPersonId(0);
    setEditPersonId(person.id);
    setModal("edit");
  }

  function openDeleteModal(person) {
    setDeletePersonId(person.id);
    setModal("delete");
  }

  function openPartnerModal(fromPersonId) {
    const anchor = fromPersonId || 0;
    setPartnerAnchorId(anchor);
    setPartnerA(anchor);
    setPartnerB(0);
    setModal("partner");
  }

  function closePartnerModal() {
    setPartnerA(0);
    setPartnerB(0);
    setPartnerAnchorId(0);
    closeModal();
  }

  function openChildModal(parentId) {
    const pid = parentId || 0;
    setChildAnchorParentId(pid);
    setParent1Id(pid);
    setParent2Id(firstLinkedPartnerId(pid, partnerMap));
    setChildId(0);
    setModal("child");
  }

  function closeChildModal() {
    setParent1Id(0);
    setParent2Id(0);
    setChildId(0);
    setChildAnchorParentId(0);
    closeModal();
  }

  // Ensure defaults stay correct if partnerMap changes after opening.
  useEffect(() => {
    if (modal !== "child") return;
    const baseParent1 = childAnchorParentId || parent1Id;
    if (!baseParent1) return;
    if (parent1Id !== baseParent1) setParent1Id(baseParent1);
    setParent2Id((cur) => (cur ? cur : firstLinkedPartnerId(baseParent1, partnerMap)));
  }, [modal, childAnchorParentId, parent1Id, partnerMap]);

  // ADMIN auth + requests UI functions and remaining UI are unchanged from our working version.
  // NOTE: For brevity, if anything is missing after restore, we can re-add quickly.

  function requestTitle(request) {
    const actionMap = { create: "Ajouter", update: "Modifier", delete: "Supprimer" };
    const entityMap = { person: "une personne", relationship: "un lien" };
    return `${actionMap[request.actionType] || request.actionType} ${entityMap[request.entityType] || request.entityType}`;
  }

  function requestDetails(request) {
    const payload = request.payload || {};
    if (request.entityType === "person") {
      const firstName = payload.firstName || "";
      const lastName = payload.lastName || "";
      const full = `${firstName} ${lastName}`.trim();
      if (request.actionType === "delete") return "Retirer cette personne de l'arbre.";
      const dec = payload.isDeceased ? " — décédé(e)" : "";
      return full ? `Personne : ${full}${dec}` : "Détails de la personne transmis.";
    }
    if (request.entityType === "relationship") {
      if (payload.relationshipType === "partner") return "Lier deux personnes en couple.";
      if (payload.relationshipType === "parent_child") return "Relier un ou deux parents à un enfant.";
    }
    return "Demande en attente d'examen.";
  }

  const deletePerson = peopleById[deletePersonId];
  const detailPerson = detailsPersonId ? peopleById[detailsPersonId] : null;
  const focusBranchPersonId = familyBranchStack.length ? familyBranchStack[familyBranchStack.length - 1] : null;
  const focusBranchPerson = focusBranchPersonId ? peopleById[focusBranchPersonId] : null;

  const focusPartners =
    focusBranchPersonId != null ? (partnerMap.get(focusBranchPersonId) ?? []).map((id) => peopleById[id]).filter(Boolean) : [];
  const focusChildren =
    focusBranchPersonId != null ? (childMap.get(focusBranchPersonId) ?? []).map((id) => peopleById[id]).filter(Boolean) : [];

  function renderPersonCard(person, { showOpenBranch = false, showDescendantCounts = false } = {}) {
    if (!person) return null;
    const partners = (partnerMap.get(person.id) ?? []).map((id) => peopleById[id]).filter(Boolean);
    const ageInfo = personAgeInfo(person);
    const directChildrenCount = (childMap.get(person.id) ?? []).length;
    const grandChildrenCount = countGrandchildren(person.id, childMap);
    return (
      <div className={`person-card${isPersonDeceased(person) ? " person-card--deceased" : ""}`}>
        <div className="avatar">
          {person.photoUrl ? (
            <img
              src={resolvePhotoUrl(person.photoUrl)}
              alt={`Photo de ${fullName(person)}`}
              className="avatar-img"
              loading="lazy"
              onClick={() => openPhotoPreview(person.photoUrl, fullName(person))}
            />
          ) : (
            initials(person)
          )}
        </div>
        <div className="person-name-row">
          <button type="button" className="person-name-btn" onClick={() => openPersonDetails(person)}>
            {fullName(person)}
          </button>
          <div className="person-inline-actions">
            <button
              type="button"
              className="icon-btn icon-btn-muted"
              title="Lier un couple"
              aria-label="Lier un couple"
              onClick={(e) => {
                e.stopPropagation();
                openPartnerModal(person.id);
              }}
            >
              <IconLink />
            </button>
            {showOpenBranch ? (
              <button
                type="button"
                className="icon-btn icon-btn-muted"
                title="Voir sa branche (partenaire et enfants)"
                aria-label="Voir sa branche familiale"
                onClick={(e) => {
                  e.stopPropagation();
                  setFamilyBranchStack((s) => [...s, person.id]);
                }}
              >
                <IconBranchFocus />
              </button>
            ) : null}
            <button
              type="button"
              className="icon-btn icon-btn-muted"
              title="Ajouter une branche enfant"
              aria-label="Ajouter une branche enfant"
              onClick={(e) => {
                e.stopPropagation();
                openChildModal(person.id);
              }}
            >
              <IconChild />
            </button>
            <button
              type="button"
              className="icon-btn icon-btn-danger"
              title={isAdmin ? "Retirer la personne" : "Demander la suppression"}
              aria-label={isAdmin ? "Retirer la personne" : "Demander la suppression de la personne"}
              onClick={(e) => {
                e.stopPropagation();
                openDeleteModal(person);
              }}
            >
              <IconTrash />
            </button>
          </div>
        </div>
        <div className="person-role">
          <span>{genreAffiche(person.gender)}</span>
          {ageInfo ? (
            <span className="person-age" title={personAgeTitle(person, ageInfo)}>
              {ageInfo.years} ans
            </span>
          ) : null}
          {isPersonDeceased(person) ? (
            <span className="person-deceased" title={deceasedTitleText(person.gender, person.deathDate)}>
              {deceasedMarkText(person.gender)}
            </span>
          ) : null}
        </div>
        {partners.length > 0 && (
          <div className="partner-line">
            <span className="heart">♥</span> {partners.map((p) => fullName(p)).join(", ")}
          </div>
        )}
        {showDescendantCounts ? (
          <div className="person-desc-stats">
            {directChildrenCount === 1 ? "1 enfant" : `${directChildrenCount} enfants`} ·{" "}
            {grandChildrenCount === 1 ? "1 petit-enfant" : `${grandChildrenCount} petits-enfants`}
          </div>
        ) : null}
      </div>
    );
  }

  function renderGenerationRow(row, idx) {
    const n = row.length;
    const countLabel = idx === 0 ? (n === 1 ? "1 personne" : `${n} personnes`) : n === 1 ? "1 enfant" : `${n} enfants`;
    return (
      <div key={idx} className="generation-row">
        <div className="generation-label">
          Génération {idx + 1}
          <span className="generation-count"> · {countLabel}</span>
        </div>
        <div className="row-people">
          {row.map((personId) => {
            const person = peopleById[personId];
            if (!person) return null;
            return (
              <Fragment key={person.id}>
                {renderPersonCard(person, { showOpenBranch: idx > 0, showDescendantCounts: idx === 1 })}
              </Fragment>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="app app-shell">
      <header className="app-header">
        <div className="app-brand">
          <div className="app-brand-top">
            <div className="app-brand-text">
              <p className="app-brand-kicker">Mémoire familiale</p>
              <h1>Arbre généalogique (Dima Thérèse)</h1>
            </div>
            <div className="header-actions">
              <button type="button" className="btn-bell" onClick={() => setModal("pending")} title="Demandes à valider" aria-label="Demandes à valider">
                <IconBell />
                {pendingRequests.length > 0 ? <span className="btn-bell-badge">{pendingRequests.length > 99 ? "99+" : pendingRequests.length}</span> : null}
              </button>
              {isAdmin ? (
                <>
                  <button
                    type="button"
                    className="btn-admin-logout"
                    onClick={() => {
                      setChangePinError("");
                      setModal("changeAdminPin");
                    }}
                    title="Changer le code administrateur"
                  >
                    Changer le code
                  </button>
                  <button type="button" className="btn-admin-logout" onClick={quitterAdmin} title="Quitter l'espace administrateur">
                    Déconnexion
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="btn-admin-logout"
                  onClick={() => {
                    setAdminLoginError("");
                    setModal("adminLogin");
                  }}
                  title="Connexion administrateur"
                >
                  Connexion administrateur
                </button>
              )}
            </div>
          </div>
          <p className="subtitle">
            {isAdmin
              ? "En tant qu'administrateur, vos modifications sont appliquées immédiatement."
              : "Les ajouts et modifications sont appliqués immédiatement. Les suppressions restent soumises à validation administrateur."}
          </p>
        </div>
      </header>

      <section className="tree-card">
        <div className="tree-card-head">
          <h2 className="tree-card-title">Votre famille</h2>
          <button type="button" className="btn-add-tree" onClick={openAddModal} title="Ajouter une personne" aria-label="Ajouter une personne">
            <IconPlus />
          </button>
        </div>
        <p className="tree-help">
          {familyBranchStack.length > 0 ? (
            <>
              Vue branche : la personne ci-dessous est le parent de référence ; couple, enfants et navigation se font depuis les icônes sur chaque fiche. Touchez un nom pour la fiche détaillée. L’icône{" "}
              <span className="tree-help-icon-inline" aria-hidden>
                <IconBranchFocus />
              </span>{" "}
              sur une fiche ouvre sa propre branche.
            </>
          ) : (
            <>
              Touchez un nom pour ouvrir sa fiche détaillée. Le bouton + ajoute une personne. La recherche ci-dessous permet d’ouvrir une fiche. À partir
              de la 2e génération, l’icône branche (
              <span className="tree-help-icon-inline" aria-hidden>
                <IconBranchFocus />
              </span>
              ) ouvre sa branche familiale. Les autres icônes : lier un couple (
              <span className="tree-help-icon-inline" aria-hidden>
                <IconLink />
              </span>
              ), ajouter une branche enfant (
              <span className="tree-help-icon-inline" aria-hidden>
                <IconChild />
              </span>
              ) et retirer la personne (
              <span className="tree-help-icon-inline" aria-hidden>
                <IconTrash />
              </span>
              ). {isAdmin ? "Vos suppressions sont immédiates." : "Les suppressions demandent une validation administrateur."}
            </>
          )}
        </p>
        {familyBranchStack.length === 0 ? (
          <div className="tree-search" ref={treeSearchRef}>
            <label className="tree-search-label" htmlFor="tree-person-search">
              Rechercher une personne
            </label>
            <input
              id="tree-person-search"
              type="search"
              className="tree-search-input"
              placeholder="Prénom ou nom…"
              value={familySearchQuery}
              onChange={(e) => setFamilySearchQuery(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              aria-autocomplete="list"
              aria-controls={familySearchTrimmed ? "tree-search-results" : undefined}
              aria-expanded={Boolean(familySearchTrimmed)}
            />
            {familySearchTrimmed ? (
              <ul id="tree-search-results" className="tree-search-results" role="listbox" aria-label="Résultats de recherche">
                {familySearchMatches.length === 0 ? (
                  <li className="tree-search-empty" role="presentation">
                    Aucune personne ne correspond.
                  </li>
                ) : (
                  familySearchMatches.map((p) => (
                    <li key={p.id} role="presentation">
                      <button
                        type="button"
                        className="tree-search-hit"
                        role="option"
                        onClick={() => {
                          openPersonDetails(p);
                          setFamilySearchQuery("");
                        }}
                      >
                        {fullName(p)}
                      </button>
                    </li>
                  ))
                )}
              </ul>
            ) : null}
          </div>
        ) : null}

        {familyBranchStack.length > 0 && focusBranchPerson ? (
          <div className="tree-branch-focus">
            <button type="button" className="tree-focus-back" onClick={() => setFamilyBranchStack((s) => s.slice(0, -1))}>
              {familyBranchStack.length <= 1 ? "← Retour à la famille" : "← Branche précédente"}
            </button>
            <h3 className="tree-focus-heading">Famille de {fullName(focusBranchPerson)}</h3>
            <div className="tree-focus-section">
              <div className="tree-focus-section-title">{focusPartners.length > 0 ? "Parents / Couple" : "Parent au centre"}</div>
              <div className="tree-focus-partners-scroll">
                <div className="row-people tree-focus-row-people">
                  <Fragment key={focusBranchPerson.id}>{renderPersonCard(focusBranchPerson, { showOpenBranch: false })}</Fragment>
                  {focusPartners.map((p) => (
                    <Fragment key={p.id}>{renderPersonCard(p, { showOpenBranch: true })}</Fragment>
                  ))}
                </div>
              </div>
            </div>
            <div className="tree-focus-section">
              <div className="tree-focus-section-title">
                Enfants
                <span className="generation-count"> · {focusChildren.length === 1 ? "1 enfant" : `${focusChildren.length} enfants`}</span>
              </div>
              {focusChildren.length === 0 ? (
                <p className="tree-focus-empty">Aucun enfant lié pour l’instant. Utilisez le bouton branche enfant sur la fiche du parent.</p>
              ) : (
                <div className="tree-focus-children-scroll">
                  <div className="row-people tree-focus-row-people">
                    {focusChildren.map((c) => (
                      <Fragment key={c.id}>{renderPersonCard(c, { showOpenBranch: true, showDescendantCounts: true })}</Fragment>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        ) : familyBranchStack.length > 0 ? (
          <div className="tree-branch-focus">
            <button type="button" className="tree-focus-back" onClick={() => setFamilyBranchStack([])}>
              ← Retour à la famille
            </button>
            <p className="tree-focus-empty">Personne introuvable.</p>
          </div>
        ) : (
          <div className={`tree-board${generationRows.length > 1 ? " tree-board--split" : ""}`}>
            {generationRows.length === 0 ? (
              <p className="tree-empty">L'arbre est encore vide. Appuyez sur + pour ajouter le premier membre de la famille.</p>
            ) : (
              <>
                <div className="tree-board-roots">{renderGenerationRow(visibleGenerationRows[0], 0)}</div>
                {visibleGenerationRows.length > 1 ? (
                  <div className="tree-board-descendants">
                    {visibleGenerationRows.slice(1).map((row, i) => renderGenerationRow(row, i + 1))}
                  </div>
                ) : null}
                {collapsedGenerationRows.length > 0 ? (
                  <div className="tree-collapsed-summary">
                    À partir de la 3e génération, {collapsedDescendantsCount} {collapsedDescendantsCount > 1 ? "personnes sont masquées" : "personne est masquée"} pour garder une vue lisible.
                    Ouvrez la branche d’un enfant (icône branche) pour explorer la suite.
                  </div>
                ) : null}
              </>
            )}
          </div>
        )}
      </section>

      {/* Modals */}
      {modal === "add" && (
        <Modal
          title="Ajouter une personne"
          onClose={closeModal}
          closeDisabled={modalSubmitting}
          footer={
            <>
              <button type="button" className="btn-secondary" onClick={closeModal} disabled={modalSubmitting}>
                Annuler
              </button>
              <button type="submit" form="form-add-person" disabled={modalSubmitting}>
                <BtnSubmitContents loading={modalSubmitting}>{saveOrRequestLabel}</BtnSubmitContents>
              </button>
            </>
          }
        >
          <form id="form-add-person" onSubmit={handleAddPersonSubmit}>
            <label className="field-label">Prénom</label>
            <input value={newPerson.firstName} onChange={(e) => setNewPerson({ ...newPerson, firstName: e.target.value })} required />
            <label className="field-label">Nom</label>
            <input value={newPerson.lastName} onChange={(e) => setNewPerson({ ...newPerson, lastName: e.target.value })} required />
            <label className="field-label">Genre</label>
            <select value={newPerson.gender} onChange={(e) => setNewPerson({ ...newPerson, gender: e.target.value })}>
              <option value="female">Femme</option>
              <option value="male">Homme</option>
              <option value="other">Autre</option>
            </select>
            <label className="field-label">Date de naissance</label>
            <input type="date" value={newPerson.birthDate} onChange={(e) => setNewPerson({ ...newPerson, birthDate: e.target.value })} />
            <label className="field-label">Photo</label>
            <input
              type="file"
              accept="image/*"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                try {
                  setNewPhotoUploading(true);
                  const url = await uploadPersonPhoto(file);
                  setNewPerson((prev) => ({ ...prev, photoUrl: url }));
                  setMessage("Photo envoyée.", "success");
                } catch (err) {
                  setMessage(err.response?.data?.error || err.message, "error");
                } finally {
                  setNewPhotoUploading(false);
                  e.target.value = "";
                }
              }}
            />
            {newPhotoUploading ? <p className="field-help">Envoi de la photo...</p> : null}
            {newPerson.photoUrl ? <img className="person-photo-preview" src={resolvePhotoUrl(newPerson.photoUrl)} alt="Aperçu photo" /> : null}
            <label className="field-checkbox">
              <input
                type="checkbox"
                checked={newPerson.isDeceased}
                onChange={(e) => setNewPerson({ ...newPerson, isDeceased: e.target.checked, deathDate: e.target.checked ? newPerson.deathDate : "" })}
              />
              <span>Décédé(e)</span>
            </label>
            {newPerson.isDeceased ? (
              <>
                <label className="field-label">Date de décès (facultatif)</label>
                <input type="date" value={newPerson.deathDate} onChange={(e) => setNewPerson({ ...newPerson, deathDate: e.target.value })} />
              </>
            ) : null}
            <label className="field-label">Notes</label>
            <textarea value={newPerson.notes} onChange={(e) => setNewPerson({ ...newPerson, notes: e.target.value })} rows={2} />
          </form>
        </Modal>
      )}

      {modal === "details" && detailsPersonId > 0 && !detailPerson && (
        <Modal title="Fiche personnelle" onClose={closePersonDetails} footer={<button type="button" onClick={closePersonDetails}>Fermer</button>}>
          <p className="person-details-muted">Cette personne n’est plus dans l’arbre.</p>
        </Modal>
      )}

      {modal === "details" && detailsPersonId > 0 && detailPerson && (
        <Modal
          title="Fiche personnelle"
          panelClassName="modal-panel--person-details"
          onClose={closePersonDetails}
          footer={
            <>
              <button type="button" className="btn-secondary" onClick={closePersonDetails}>
                Fermer
              </button>
              <button type="button" onClick={() => openEditFromDetails(detailPerson)}>
                Modifier la fiche
              </button>
            </>
          }
        >
          {(() => {
            const p = detailPerson;
            const parents = (parentMap.get(p.id) ?? [])
              .map((id) => peopleById[id])
              .filter(Boolean)
              .sort((a, b) => a.id - b.id);
            const parentNames = parents.map((x) => fullName(x));
            const filiation = p.gender === "male" ? "fils de" : p.gender === "female" ? "fille de" : "enfant de";
            const intro = parentNames.length === 0 ? `${fullName(p)} — filiation non renseignée dans l’arbre.` : `${fullName(p)}, ${filiation} ${joinFrenchAnd(parentNames)}.`;
            const bornLead = p.gender === "female" ? "Née le" : p.gender === "male" ? "Né le" : "Né(e) le";
            const birthSentence = p.birthDate ? `${bornLead} ${formatLongFrenchDate(p.birthDate)}.` : "Date de naissance non renseignée.";
            const partners = (partnerMap.get(p.id) ?? []).map((id) => peopleById[id]).filter(Boolean);
            const nChildren = (childMap.get(p.id) ?? []).length;
            const nGrand = countGrandchildren(p.id, childMap);
            const nGreat = countGreatGrandchildren(p.id, childMap);
            const ageNow = personAgeInfo(p);
            const deathYear = deathCalendarYear(p.deathDate);
            const decLabel = p.gender === "female" ? "Décédée" : p.gender === "male" ? "Décédé" : "Décédé·e";
            return (
              <div className="person-details">
                <div className="person-details-top">
                  {p.photoUrl ? (
                    <div className="person-details-photo-wrap">
                      <button
                        type="button"
                        className="person-details-photo-btn"
                        onClick={() => openPhotoPreview(p.photoUrl, fullName(p))}
                        aria-label={`Agrandir la photo de ${fullName(p)}`}
                      >
                        <img
                          src={resolvePhotoUrl(p.photoUrl)}
                          alt={`Photo de ${fullName(p)}`}
                          className="person-details-photo"
                          loading="lazy"
                        />
                      </button>
                    </div>
                  ) : null}
                  <div className="person-details-main">
                <p className="person-details-lead">{intro}</p>
                <p className="person-details-block">{birthSentence}</p>
                <p className="person-details-block">
                  <span className="person-details-label">Genre</span> {genreAffiche(p.gender)}.
                </p>
                {partners.length ? (
                  <p className="person-details-block">
                    <span className="person-details-label">Couple</span> avec {joinFrenchAnd(partners.map((x) => fullName(x)))}.
                  </p>
                ) : null}
                {!p.isDeceased && ageNow && !ageNow.ageAtDeath ? <p className="person-details-block person-details-muted">Âge aujourd’hui : {ageNow.years} ans.</p> : null}
                <div className="person-details-section">
                  <h3 className="person-details-section-title">Descendance dans l’arbre</h3>
                  {nChildren === 0 && nGrand === 0 && nGreat === 0 ? (
                    <p className="person-details-muted">Aucun descendant enregistré.</p>
                  ) : (
                    <ul className="person-details-list">
                      {nChildren > 0 ? <li>{nChildren === 1 ? "1 enfant" : `${nChildren} enfants`}</li> : null}
                      {nGrand > 0 ? <li>{nGrand === 1 ? "1 petit-enfant" : `${nGrand} petits-enfants`}</li> : null}
                      {nGreat > 0 ? <li>{nGreat === 1 ? "1 arrière-petit-enfant" : `${nGreat} arrière-petits-enfants`}</li> : null}
                    </ul>
                  )}
                </div>
                {p.isDeceased ? (
                  <div className="person-details-section person-details-section--death">
                    <h3 className="person-details-section-title">Décès</h3>
                    {deathYear && ageNow?.ageAtDeath ? (
                      <p>
                        {decLabel} en {deathYear}, à l’âge de {ageNow.years} ans{p.deathDate ? ` (${formatLongFrenchDate(p.deathDate)}).` : "."}
                      </p>
                    ) : deathYear ? (
                      <p>
                        {decLabel} en {deathYear}.
                      </p>
                    ) : (
                      <p>{decLabel} — date de décès non renseignée.</p>
                    )}
                  </div>
                ) : null}
                {String(p.notes ?? "").trim() ? (
                  <div className="person-details-section">
                    <h3 className="person-details-section-title">Notes</h3>
                    <p className="person-details-notes">{String(p.notes).trim()}</p>
                  </div>
                ) : null}
                  </div>
                </div>
              </div>
            );
          })()}
        </Modal>
      )}

      {modal === "edit" && editPersonId > 0 && (
        <Modal
          title="Modifier une personne"
          onClose={() => {
            setEditPersonId(0);
            closeModal();
          }}
          closeDisabled={modalSubmitting}
          footer={
            <>
              <button type="button" className="btn-secondary" onClick={() => { setEditPersonId(0); closeModal(); }} disabled={modalSubmitting}>
                Annuler
              </button>
              <button type="submit" form="form-edit-person" disabled={modalSubmitting}>
                <BtnSubmitContents loading={modalSubmitting}>{saveOrRequestLabel}</BtnSubmitContents>
              </button>
            </>
          }
        >
          <form id="form-edit-person" onSubmit={handleEditPersonSubmit}>
            <label className="field-label">Prénom</label>
            <input value={editPerson.firstName} onChange={(e) => setEditPerson({ ...editPerson, firstName: e.target.value })} required />
            <label className="field-label">Nom</label>
            <input value={editPerson.lastName} onChange={(e) => setEditPerson({ ...editPerson, lastName: e.target.value })} required />
            <label className="field-label">Genre</label>
            <select value={editPerson.gender} onChange={(e) => setEditPerson({ ...editPerson, gender: e.target.value })}>
              <option value="female">Femme</option>
              <option value="male">Homme</option>
              <option value="other">Autre</option>
            </select>
            <label className="field-label">Date de naissance</label>
            <input type="date" value={editPerson.birthDate} onChange={(e) => setEditPerson({ ...editPerson, birthDate: e.target.value })} />
            <label className="field-label">Photo</label>
            <input
              type="file"
              accept="image/*"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                try {
                  setEditPhotoUploading(true);
                  const url = await uploadPersonPhoto(file);
                  setEditPerson((prev) => ({ ...prev, photoUrl: url }));
                  setMessage("Photo envoyée.", "success");
                } catch (err) {
                  setMessage(err.response?.data?.error || err.message, "error");
                } finally {
                  setEditPhotoUploading(false);
                  e.target.value = "";
                }
              }}
            />
            {editPhotoUploading ? <p className="field-help">Envoi de la photo...</p> : null}
            {editPerson.photoUrl ? <img className="person-photo-preview" src={resolvePhotoUrl(editPerson.photoUrl)} alt="Aperçu photo" /> : null}
            <label className="field-checkbox">
              <input
                type="checkbox"
                checked={editPerson.isDeceased}
                onChange={(e) => setEditPerson({ ...editPerson, isDeceased: e.target.checked, deathDate: e.target.checked ? editPerson.deathDate : "" })}
              />
              <span>Décédé(e)</span>
            </label>
            {editPerson.isDeceased ? (
              <>
                <label className="field-label">Date de décès (facultatif)</label>
                <input type="date" value={editPerson.deathDate} onChange={(e) => setEditPerson({ ...editPerson, deathDate: e.target.value })} />
              </>
            ) : null}
            <label className="field-label">Notes</label>
            <textarea value={editPerson.notes} onChange={(e) => setEditPerson({ ...editPerson, notes: e.target.value })} rows={2} />
          </form>
        </Modal>
      )}

      {modal === "delete" && deletePersonId > 0 && (
        <Modal
          title="Retirer une personne"
          onClose={() => { setDeletePersonId(0); closeModal(); }}
          closeDisabled={modalSubmitting}
          footer={
            <>
              <button type="button" className="btn-secondary" onClick={() => { setDeletePersonId(0); closeModal(); }} disabled={modalSubmitting}>
                Annuler
              </button>
              <button type="submit" form="form-delete-person" className="danger" disabled={modalSubmitting}>
                <BtnSubmitContents loading={modalSubmitting}>
                  {isAdmin ? "Retirer de l'arbre" : "Demander la suppression"}
                </BtnSubmitContents>
              </button>
            </>
          }
        >
          <form id="form-delete-person" onSubmit={handleDeletePersonConfirm}>
            <p className="modal-lead">
              {isAdmin
                ? <>Retirer <strong>{deletePerson ? fullName(deletePerson) : "cette personne"}</strong> de l'arbre ?</>
                : <>Envoyer une demande de suppression pour <strong>{deletePerson ? fullName(deletePerson) : "cette personne"}</strong> ?</>}
            </p>
          </form>
        </Modal>
      )}

      {modal === "partner" && (
        <Modal
          title="Lier un couple"
          onClose={closePartnerModal}
          closeDisabled={modalSubmitting}
          footer={
            <>
              <button type="button" className="btn-secondary" onClick={closePartnerModal} disabled={modalSubmitting}>
                Annuler
              </button>
              <button type="submit" form="form-partner" disabled={modalSubmitting || !partnerA || !partnerB || partnerA === partnerB}>
                <BtnSubmitContents loading={modalSubmitting}>{saveOrRequestLabel}</BtnSubmitContents>
              </button>
            </>
          }
        >
          <form id="form-partner" onSubmit={handlePartnerSubmit}>
            <label className="field-label">Personne A</label>
            <select value={partnerA} onChange={(e) => setPartnerA(Number(e.target.value))} disabled={Boolean(partnerAnchorId)}>
              <option value={0}>Choisir…</option>
              {people
                .filter((person) => !excludedPartnerAIds.has(person.id))
                .map((person) => (
                  <option key={person.id} value={person.id}>
                    {fullName(person)}
                  </option>
                ))}
            </select>
            <label className="field-label">Personne B</label>
            <select value={partnerB} onChange={(e) => setPartnerB(Number(e.target.value))}>
              <option value={0}>Choisir…</option>
              {people
                .filter((person) => !excludedPartnerBIds.has(person.id))
                .map((person) => (
                  <option key={person.id} value={person.id}>
                    {fullName(person)}
                  </option>
                ))}
            </select>
          </form>
        </Modal>
      )}

      {modal === "child" && (
        <Modal
          title="Ajouter une branche enfant"
          onClose={closeChildModal}
          closeDisabled={modalSubmitting}
          footer={
            <>
              <button type="button" className="btn-secondary" onClick={closeChildModal} disabled={modalSubmitting}>
                Annuler
              </button>
              <button
                type="submit"
                form="form-child"
                disabled={modalSubmitting || !parent1Id || !childId || parent1Id === childId || parent2Id === childId}
              >
                <BtnSubmitContents loading={modalSubmitting}>{saveOrRequestLabel}</BtnSubmitContents>
              </button>
            </>
          }
        >
          <form id="form-child" onSubmit={handleChildBranchSubmit}>
            <label className="field-label">Parent 1</label>
            <select
              value={parent1Id}
              disabled={Boolean(childAnchorParentId)}
              onChange={(e) => {
                const v = Number(e.target.value);
                setParent1Id(v);
                setParent2Id(firstLinkedPartnerId(v, partnerMap));
              }}
            >
              <option value={0}>Choisir…</option>
              {childAnchorParentId
                ? (() => {
                    const p = peopleById[childAnchorParentId];
                    return p ? [p] : [];
                  })().map((person) => (
                    <option key={person.id} value={person.id}>
                      {fullName(person)}
                    </option>
                  ))
                : people
                    .filter((person) => !excludedForFirstParent.has(person.id))
                    .map((person) => (
                      <option key={person.id} value={person.id}>
                        {fullName(person)}
                      </option>
                    ))}
            </select>
            <label className="field-label">Parent 2 (facultatif)</label>
            <select value={parent2Id} onChange={(e) => setParent2Id(Number(e.target.value))}>
              <option value={0}>Aucun</option>
              {people
                .filter((person) => !excludedForSecondParent.has(person.id))
                .map((person) => (
                  <option key={person.id} value={person.id}>
                    {fullName(person)}
                  </option>
                ))}
            </select>
            <label className="field-label">Enfant</label>
            <select value={childId} onChange={(e) => setChildId(Number(e.target.value))}>
              <option value={0}>Choisir…</option>
              {childBranchCandidates.map((person) => (
                <option key={person.id} value={person.id}>
                  {fullName(person)}
                </option>
              ))}
            </select>
          </form>
        </Modal>
      )}

      {modal === "adminLogin" && (
        <Modal
          title="Connexion administrateur"
          onClose={() => {
            setAdminPinDraft("");
            setShowAdminPin(false);
            setAdminLoginError("");
            closeModal();
          }}
          closeDisabled={modalSubmitting}
          footer={
            <>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  setAdminPinDraft("");
                  setShowAdminPin(false);
                  setAdminLoginError("");
                  closeModal();
                }}
                disabled={modalSubmitting}
              >
                Annuler
              </button>
              <button type="submit" form="form-admin-login" disabled={modalSubmitting}>
                <BtnSubmitContents loading={modalSubmitting}>Valider</BtnSubmitContents>
              </button>
            </>
          }
        >
          <form id="form-admin-login" onSubmit={connecterAdmin}>
            {adminLoginError ? (
              <div className="modal-error" role="alert">
                <span className="modal-error-icon" aria-hidden>
                  <IconMsgError />
                </span>
                <span>{adminLoginError}</span>
              </div>
            ) : null}
            <PinField
              label="Code administrateur"
              id="admin-pin-input"
              autoComplete="current-password"
              placeholder="••••••••"
              value={adminPinDraft}
              onChange={(e) => {
                setAdminPinDraft(e.target.value);
                setAdminLoginError("");
              }}
              visible={showAdminPin}
              onToggle={() => setShowAdminPin((v) => !v)}
            />
          </form>
        </Modal>
      )}

      {modal === "changeAdminPin" && (
        <Modal
          title="Changer le code administrateur"
          onClose={() => {
            setChangePin({ current: "", next: "", confirm: "" });
            setShowChangePinFields({ current: false, next: false, confirm: false });
            setChangePinError("");
            closeModal();
          }}
          closeDisabled={modalSubmitting}
          footer={
            <>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  setChangePin({ current: "", next: "", confirm: "" });
                  setShowChangePinFields({ current: false, next: false, confirm: false });
                  setChangePinError("");
                  closeModal();
                }}
                disabled={modalSubmitting}
              >
                Annuler
              </button>
              <button type="submit" form="form-change-pin" disabled={modalSubmitting}>
                <BtnSubmitContents loading={modalSubmitting}>Enregistrer</BtnSubmitContents>
              </button>
            </>
          }
        >
          <form id="form-change-pin" onSubmit={soumettreChangementCode}>
            <p className="modal-lead">Au moins 4 caractères pour le nouveau code.</p>
            {changePinError ? (
              <div className="modal-error" role="alert">
                <span className="modal-error-icon" aria-hidden>
                  <IconMsgError />
                </span>
                <span>{changePinError}</span>
              </div>
            ) : null}
            <PinField
              label="Code actuel"
              id="change-pin-current"
              autoComplete="current-password"
              value={changePin.current}
              onChange={(e) => {
                setChangePin({ ...changePin, current: e.target.value });
                setChangePinError("");
              }}
              visible={showChangePinFields.current}
              onToggle={() => setShowChangePinFields((v) => ({ ...v, current: !v.current }))}
            />
            <PinField
              label="Nouveau code"
              id="change-pin-next"
              autoComplete="new-password"
              value={changePin.next}
              onChange={(e) => {
                setChangePin({ ...changePin, next: e.target.value });
                setChangePinError("");
              }}
              visible={showChangePinFields.next}
              onToggle={() => setShowChangePinFields((v) => ({ ...v, next: !v.next }))}
            />
            <PinField
              label="Confirmer le nouveau code"
              id="change-pin-confirm"
              autoComplete="new-password"
              value={changePin.confirm}
              onChange={(e) => {
                setChangePin({ ...changePin, confirm: e.target.value });
                setChangePinError("");
              }}
              visible={showChangePinFields.confirm}
              onToggle={() => setShowChangePinFields((v) => ({ ...v, confirm: !v.confirm }))}
            />
          </form>
        </Modal>
      )}

      {modal === "pending" && (
        <Modal
          title="Demandes en attente"
          onClose={closeModal}
          closeDisabled={Boolean(pendingAction)}
          footer={
            <button type="button" className="btn-secondary" onClick={closeModal} disabled={Boolean(pendingAction)}>
              Fermer
            </button>
          }
        >
          {pendingRequests.length === 0 ? (
            <p>Aucune demande en attente.</p>
          ) : (
            pendingRequests.map((r) => {
              const rowBusy = pendingAction?.id === r.id;
              const approveBusy = rowBusy && pendingAction?.kind === "approve";
              const rejectBusy = rowBusy && pendingAction?.kind === "reject";
              return (
                <div key={r.id} className="pending-request-row">
                  <strong>{requestTitle(r)}</strong>
                  <div className="request-meta">{requestDetails(r)}</div>
                  {isAdmin ? (
                    <div className="actions">
                      <button type="button" onClick={() => approveRequest(r.id)} disabled={Boolean(pendingAction)}>
                        {approveBusy ? (
                          <span className="btn-submit-inner">
                            <span className="btn-spinner" aria-hidden />
                            <span>En cours…</span>
                          </span>
                        ) : (
                          "Accepter"
                        )}
                      </button>
                      <button type="button" className="danger" onClick={() => rejectRequest(r.id)} disabled={Boolean(pendingAction)}>
                        {rejectBusy ? (
                          <span className="btn-submit-inner">
                            <span className="btn-spinner" aria-hidden />
                            <span>En cours…</span>
                          </span>
                        ) : (
                          "Refuser"
                        )}
                      </button>
                    </div>
                  ) : (
                    <span className="request-wait">En attente de validation par un administrateur.</span>
                  )}
                </div>
              );
            })
          )}
        </Modal>
      )}

      {toast ? (
        <div className="toast-host" aria-live={toast.variant === "error" ? "assertive" : "polite"}>
          <div className={`toast message message--${toast.variant}${toastOpen ? " toast--open" : ""}`} role={toast.variant === "error" ? "alert" : "status"} onTransitionEnd={handleToastTransitionEnd}>
            <span className="message-icon" aria-hidden>
              <MessageIcon variant={toast.variant} />
            </span>
            <span className="message-text">{toast.text}</span>
            <button type="button" className="toast-dismiss" onClick={() => setToastOpen(false)} aria-label="Fermer la notification">
              ×
            </button>
          </div>
        </div>
      ) : null}

      {photoPreview ? (
        <div className="photo-lightbox" role="dialog" aria-modal="true" onClick={closePhotoPreview}>
          <div className="photo-lightbox-inner" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="photo-lightbox-close" onClick={closePhotoPreview} aria-label="Fermer la photo">
              ×
            </button>
            <img className="photo-lightbox-img" src={photoPreview.url} alt={`Photo de ${photoPreview.name}`} />
            <p className="photo-lightbox-caption">{photoPreview.name}</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default App;
