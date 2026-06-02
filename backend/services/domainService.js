/**
 * App-managed "domains" (a.k.a. verticals like HR, Bank, Sales) that group
 * data products. These live entirely in the app's Firestore — they are NOT
 * written to Dataplex — so the catalog stays untouched while the business can
 * organize data products into a two-level hierarchy (domain -> products).
 *
 * Firestore collection: data-product-domains
 * Document shape: { id, name, description, owner, productIds: [], createdAt, updatedAt }
 */

const { Firestore } = require('@google-cloud/firestore');
const crypto = require('crypto');

let firestore = null;
const getFirestore = () => {
  if (!firestore) {
    const projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID;
    firestore = new Firestore(projectId ? { projectId } : {});
  }
  return firestore;
};

const COLLECTION = 'data-product-domains';

const slugify = (name) =>
  String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);

const listDomains = async () => {
  const snap = await getFirestore().collection(COLLECTION).get();
  return snap.docs.map((d) => d.data());
};

const getDomain = async (id) => {
  const doc = await getFirestore().collection(COLLECTION).doc(id).get();
  return doc.exists ? doc.data() : null;
};

const createDomain = async ({ name, description, owner }) => {
  if (!name || !String(name).trim()) {
    throw new Error('Domain name is required');
  }
  const db = getFirestore();
  let id = slugify(name) || `domain-${crypto.randomBytes(3).toString('hex')}`;

  // Ensure a unique document id.
  const existing = await db.collection(COLLECTION).doc(id).get();
  if (existing.exists) {
    id = `${id}-${crypto.randomBytes(2).toString('hex')}`;
  }

  const now = new Date().toISOString();
  const payload = {
    id,
    name: String(name).trim(),
    description: description ? String(description) : '',
    owner: owner || '',
    productIds: [],
    createdAt: now,
    updatedAt: now,
  };
  await db.collection(COLLECTION).doc(id).set(payload);
  return payload;
};

const updateDomain = async (id, fields) => {
  const db = getFirestore();
  const ref = db.collection(COLLECTION).doc(id);
  const doc = await ref.get();
  if (!doc.exists) throw new Error('Domain not found');

  const update = { updatedAt: new Date().toISOString() };
  if (fields.name != null) update.name = String(fields.name).trim();
  if (fields.description != null) update.description = String(fields.description);
  if (fields.owner != null) update.owner = String(fields.owner);
  await ref.update(update);
  return getDomain(id);
};

const deleteDomain = async (id) => {
  await getFirestore().collection(COLLECTION).doc(id).delete();
  return true;
};

/**
 * Assign a data product to a domain. A product belongs to at most one domain,
 * so we remove it from any other domain first.
 */
const assignProduct = async (domainId, productId) => {
  if (!productId) throw new Error('productId is required');
  const db = getFirestore();
  const snap = await db.collection(COLLECTION).get();
  const batch = db.batch();
  let targetExists = false;
  const now = new Date().toISOString();

  snap.docs.forEach((d) => {
    const data = d.data();
    const ids = data.productIds || [];
    const has = ids.includes(productId);
    if (d.id === domainId) {
      targetExists = true;
      if (!has) batch.update(d.ref, { productIds: [...ids, productId], updatedAt: now });
    } else if (has) {
      batch.update(d.ref, { productIds: ids.filter((p) => p !== productId), updatedAt: now });
    }
  });

  if (!targetExists) throw new Error('Domain not found');
  await batch.commit();
  return getDomain(domainId);
};

/** Remove a data product from whatever domain it belongs to. */
const unassignProduct = async (productId) => {
  if (!productId) throw new Error('productId is required');
  const db = getFirestore();
  const snap = await db.collection(COLLECTION).get();
  const batch = db.batch();
  const now = new Date().toISOString();
  snap.docs.forEach((d) => {
    const ids = d.data().productIds || [];
    if (ids.includes(productId)) {
      batch.update(d.ref, { productIds: ids.filter((p) => p !== productId), updatedAt: now });
    }
  });
  await batch.commit();
  return true;
};

module.exports = {
  listDomains,
  getDomain,
  createDomain,
  updateDomain,
  deleteDomain,
  assignProduct,
  unassignProduct,
  COLLECTION,
};
