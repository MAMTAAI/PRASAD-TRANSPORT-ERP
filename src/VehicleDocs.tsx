// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { extractDocument } from './lib/aiScanner';
import { uploadMedia, slug } from './lib/uploadMedia';
import { toISODate } from './lib/accounting/tripMath';

import { API_BASE } from './lib/apiBase';
import { openDocument } from './lib/openDocument';
import UnmappedDocumentQueue from './components/UnmappedDocumentQueue';
import ComplianceGapsWidget from './components/ComplianceGapsWidget';
import DepartmentQueue from './components/DepartmentQueue';
import WatchdogWidget from './components/WatchdogWidget';
const API = API_BASE;
const MASTERS = `${API}/api/v1/masters`;
const FIN = `${API}/api/v1/finance`;

const fetchJson = async (url: string, opts?: RequestInit) => {
  const res = await fetch(url, opts);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.detail || json.error || `HTTP ${res.status}`), { code: json.error });
  return json;
};

// Legacy scans stored values like ":AS240718V5684090" — strip stray leading
// punctuation/labels so old data displays and saves clean.
const cleanRef = (v: any): string => String(v ?? '').replace(/^[\s:;,.-]+/, '').trim();

// Case-tolerant plate lookup: real data stores vehicle_no / vehical_no /
// Vehicle_No — the lowercase-only lookup rendered one real truck as "Unknown Plate".
const plateOf = (v: any): string => String(getVal(v, ['vehicle_no', 'vehical_no', 'vehicleno']) || '').trim();

// 🔥 SUPER SMART AUTO-RECOVERY HELPER (Case-Insensitive)
const getVal = (obj: any, keysArr: string[], defaultVal = '') => {
  if(!obj || typeof obj !== 'object') return defaultVal;
  const objKeys = Object.keys(obj);
  for(const k of keysArr) {
     const target = k.toLowerCase().replace(/[^a-z0-9]/g, '');
     const found = objKeys.find(ok => ok.toLowerCase().replace(/[^a-z0-9]/g, '') === target);
     if(found && obj[found] !== undefined && obj[found] !== null && obj[found] !== '') return obj[found];
  }
  return defaultVal;
};

// 🕵️‍♂️ AGGRESSIVE DEEP LINK EXTRACTOR (Finds any URL hidden in old data)
const extractDeepLink = (obj: any): string => {
  if (!obj) return '';
  // 1. Try common keys first
  const common = getVal(obj, ['document_file', 'file_url', 'url', 'link', 'doc_link', 'driveLink', 'file', 'documentFile', 'attachment', 'image', 'pdf', 'upload']);
  if (typeof common === 'string' && (common.includes('http') || common.includes('drive'))) return common;

  // 2. If not found, deeply scan the entire object for ANYTHING starting with http
  let foundLink = '';
  const searchDeep = (target: any) => {
    if (foundLink) return;
    if (typeof target === 'string' && target.includes('http')) {
      foundLink = target;
      return;
    }
    if (typeof target === 'object' && target !== null) {
      Object.values(target).forEach(searchDeep);
    }
  };
  searchDeep(obj);
  return foundLink;
};

// 🌟 Universal Mapper for Old Data
const parseOldDocData = (rawData: any, type: any) => {
  if(!rawData) return {};
  const mapped = {
    ...rawData,
    application_no: cleanRef(getVal(rawData, ['application_no', 'Application_No', 'policy_no', 'Policy_No', 'policyNo'])),
    receipt_no: cleanRef(getVal(rawData, ['receipt_no', 'Receipt_No', 'challan_no', 'receiptNo'])),
    inspected_on: getVal(rawData, ['inspected_on', 'issue_date', 'Issue_Date', 'valid_from', 'issueDate', 'date']),
    next_due_date: getVal(rawData, ['next_due_date', 'expiry_date', 'Expiry_Date', 'valid_till', 'expiryDate']),
    amount: getVal(rawData, ['amount', 'Amount', 'total_fees', 'Total_Fees', 'fees', 'totalAmount']),
    payment_mode: getVal(rawData, ['payment_mode', 'Payment_Mode', 'mode']),
    document_file: extractDeepLink(rawData), // Uses the new Deep Scanner
  };
  if (type && type.id.startsWith('custom_')) mapped.doc_name = type.name;
  return mapped;
};

export default function VehicleDocs() {
  const [vehicles, setVehicles] = useState<any[]>([]);
  const [selectedVehicle, setSelectedVehicle] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [aiScanning, setAiScanning] = useState(false);
  const [uploadingDoc, setUploadingDoc] = useState(false);

  const [scannedAIData, setScannedAIData] = useState<any>(null);

  const [searchTerm, setSearchTerm] = useState('');
  const [filterCompany, setFilterCompany] = useState('');
  const [filterOwner, setFilterOwner] = useState('');
  const [companies, setCompanies] = useState<any[]>([]);

  const portals = [
    { name: 'Parivahan (Fitness/Permit)', url: 'https://vahan.parivahan.gov.in/vahan/vahan/ui/login/login.xhtml' },
    { name: 'E-Challan System', url: 'https://echallan.parivahan.gov.in/' },
    { name: 'Insurance (V-Seva)', url: 'https://www.vsez.gov.in/' },
    { name: 'DigiLocker Admin', url: 'https://digitallocker.gov.in/' }
  ];

  // 📝 DYNAMIC DOC TYPES
  const [docTypes, setDocTypes] = useState([
    { id: 'fitness', name: '1. Fitness / Inspection' },
    { id: 'insurance', name: '2. Vehicle Insurance' },
    { id: 'explosive', name: '3. Explosive License' },
    { id: 'calibration', name: '4. Certificate Calibration' },
    { id: 'rule18', name: '5. Rule 18 (Hydro Test)' },
    { id: 'rule43', name: '6. Rule 43 (Safety Cert)' },
    { id: 'cii', name: '7. CII Insurance' },
    { id: 'national_permit', name: '8. National Permit' },
    { id: 'pollution', name: '9. Pollution (PUC)' },
    { id: 'home_permit', name: '10. Home State Permit' },
    { id: 'mv_tax', name: '11. MV Tax' },
  ]);

  const [newDocName, setNewDocName] = useState('');

  const [activeTab, setActiveTab] = useState(docTypes[0]);
  const [formData, setFormData] = useState<any>({});

  useEffect(() => {
    fetchVehicles();
    fetchCompanies();
  }, []);

  const [accounts, setAccounts] = useState<any[]>([]);
  const [payAccount, setPayAccount] = useState('');
  const [docsByType, setDocsByType] = useState<any>({});
  const [err, setErr] = useState('');
  // Expiries across the whole fleet AND its drivers, judged server-side against
  // one threshold. Not derived here: a licence that lapsed stops a lorry just
  // as surely as a lapsed fitness certificate, and only the database sees both.
  const [alerts, setAlerts] = useState<any | null>(null);
  // Drivers, so a queued Aadhaar or licence can be linked to the person it
  // belongs to without leaving the screen.
  const [drivers, setDrivers] = useState<any[]>([]);

  const fetchVehicles = async () => {
    setLoading(true);
    setErr('');
    try {
      const [v, m, acc] = await Promise.all([
        fetchJson(`${MASTERS}/vehicles?limit=1000`),
        fetchJson(`${FIN}/masters/companies`),
        // Bank and cash accounts, for the compliance-fee selector. A fee moves
        // real money, so the operator names the account — nothing is defaulted.
        fetchJson(`${FIN}/accounts`),
      ]);
      setVehicles(v.vehicles ?? []);
      setCompanies(m.companies ?? []);
      setAccounts(acc.accounts ?? []);

      // Separately fault-tolerant: the alert strip is a warning, and failing to
      // draw it must not take the document screen down with it.
      fetchJson(`${API}/api/v1/compliance/alerts`)
        .then(setAlerts)
        .catch(() => setAlerts(null));

      // Drivers, so a queued Aadhaar or licence can be linked to the person it
      // belongs to without leaving the screen. Fault-tolerant for the same
      // reason as the alert strip.
      fetchJson(`${MASTERS}/drivers?limit=1000`)
        .then((d: any) => setDrivers(d.drivers ?? []))
        .catch(() => setDrivers([]));
    } catch (e: any) {
      setVehicles([]);
      setErr(`Fleet could not load from ${API} — ${e.message}`);
    }
    setLoading(false);
  };

  const fetchCompanies = async () => {};

  // Every stored document for one vehicle, keyed by doc_type so the tabs read it
  // exactly as they read the old nested map.
  const loadDocsFor = async (vehicleId: string) => {
    try {
      const j = await fetchJson(`${MASTERS}/vehicle-documents?vehicle_id=${vehicleId}`);
      const byType: any = {};
      for (const d of j.documents ?? []) {
        byType[d.doc_type] = {
          application_no: d.application_no ?? '',
          receipt_no: d.receipt_no ?? '',
          inspected_on: d.inspected_on ?? '',
          next_due_date: d.next_due_date ?? '',
          amount: d.amount ?? '',
          payment_mode: d.payment_mode ?? '',
          document_file: d.document_url ?? '',
          doc_name: d.doc_name ?? '',
          _id: d.id,
          _voucher_id: d.voucher_id,
          _state: d.compliance_state,
          _days: d.days_to_expiry,
        };
      }
      setDocsByType(byType);
      return byType;
    } catch { setDocsByType({}); return {}; }
  };

  const loadVehicleDocs = async (vehicle: any) => {
    const currentTypes = [...docTypes.slice(0, 11)];
    const byType = await loadDocsFor(vehicle.id);
    // Custom document types are discovered from what this vehicle already has:
    // an operator-defined doc carries its own name on the row.
    for (const [type, d] of Object.entries<any>(byType)) {
      if (type.startsWith('custom_') && !currentTypes.some((t) => t.id === type)) {
        currentTypes.push({ id: type, name: d.doc_name || `📄 ${type.replace('custom_', '')}` });
      }
    }
    setDocTypes(currentTypes);
    setSelectedVehicle(vehicle);
    setActiveTab(currentTypes[0]);
    setFormData(byType[currentTypes[0].id] ?? {});
    setPayAccount('');
    setScannedAIData(null);
  };

  const handleAddCustomDoc = () => {
    if(!newDocName.trim()) return alert("Please enter a document name.");
    const newId = `custom_${Date.now()}`;
    const newDoc = { id: newId, name: `📄 ${newDocName}` };
    setDocTypes([...docTypes, newDoc]);
    setNewDocName('');
    handleTabChange(newDoc); 
  };

  const handleTabChange = (type: any) => {
    setActiveTab(type);
    setFormData(docsByType[type.id] ?? {});
    setPayAccount('');
    setScannedAIData(null);
  };

  // ── IS THIS FEE BEING PAID, OR MERELY REDISPLAYED? ─────────────────────
  //
  // docsByType is what the server holds; formData is the operator's edited
  // copy. A fee that came back from the database has already been paid and
  // already been accounted for — reopening the tab and pressing Save must not
  // post it a second time. Only a fee that DIFFERS from the stored one is a
  // payment being made now.
  //
  // This matters because the 2026-08-28 restore filed 79 documents carrying a
  // fee from the old Firestore system with no voucher_id — that money was
  // posted in the old books. Keying off voucher_id alone would have called
  // every one of them an unpaid fee and offered to post it a second time.
  const storedAmount = parseFloat(docsByType?.[activeTab?.id]?.amount || '0') || 0;
  const enteredAmount = parseFloat(formData.amount || '0') || 0;
  const feeIsNew = enteredAmount > 0 && enteredAmount !== storedAmount;

  const handleInputChange = (e: any) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  // 📎 REAL upload (Firebase Storage) + 🤖 local Gemma OCR, in parallel.
  // The old flow only ran OCR and DISCARDED the file — new documents never got
  // a View/Download link and the AI Scan button stayed permanently disabled.
  const handleFileUpload = async (e: any) => {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = '';

    setUploadingDoc(true);
    setScannedAIData(null);

    const vNo = slug(plateOf(selectedVehicle) || 'vehicle');
    // The extension has to come from the file. Hard-coded ".jpg" stored every
    // PDF certificate under an image name, so "View Document" handed the
    // browser a PDF labelled as a picture and it rendered as broken.
    const ext = (file.name?.match(/\.([A-Za-z0-9]+)$/)?.[1]
      || (file.type === 'application/pdf' ? 'pdf' : 'jpg')).toLowerCase();
    const uploadPromise = uploadMedia(file, `vehicle-docs/${vNo}/${slug(activeTab.id)}_${Date.now()}.${ext}`);

    // A dead Ollama must not lose the document — store the file regardless.
    let storedUrl = '';
    try {
      const { url } = await uploadPromise;
      storedUrl = url;
      setFormData(prev => ({ ...prev, document_file: url }));
    } catch (err) {
      console.error(err);
      alert('❌ File upload nahi hui — network check karke dobara try karein.');
      setUploadingDoc(false);
      return;
    }

    try {
      // 🤖 100% LOCAL extraction via Gemma 4 vision (no cloud).
      const ex = await extractDocument(file, activeTab.name);
      const docNum = cleanRef(ex.document_number).replace(/[^A-Za-z0-9/-]/g, '').trim();
      setFormData(prev => ({
        ...prev,
        document_file: storedUrl,
        application_no: docNum || prev.application_no || '',
        receipt_no: docNum || prev.receipt_no || '',
        inspected_on: formatForDatePicker(ex.issue_date) || prev.inspected_on || '',
        next_due_date: formatForDatePicker(ex.expiry_date) || prev.next_due_date || '',
      }));
      setScannedAIData(ex);
      // SAY WHICH OF THE TWO HAPPENED. extractDocument does not throw when it
      // reads nothing — it returns empty strings — so this line claimed "padh
      // liya" over a scan that had filled not one field, and the operator was
      // left looking for data the message promised. Report what actually landed.
      const got = [docNum && 'number', ex.issue_date && 'issue date', ex.expiry_date && 'expiry date']
        .filter(Boolean);
      alert(got.length
        ? `✅ File save + ${activeTab.name} se mila: ${got.join(', ')}. Kripya verify karein.`
        : `✅ File save ho gayi — lekin scan se koi field nahi nikli.\nFields haath se bharein aur SAVE dabayein.`);
    } catch (error: any) {
      const offline = error?.name === 'LLMOfflineError' || /ollama|engine|reach/i.test(error?.message || '');
      alert(`✅ File save ho gayi.\n${offline ? '⚠️ Local AI engine (Ollama) band hai — scan nahi hua, fields manually bharein.' : '⚠️ Document scan nahi ho paya (file phir bhi save hai) — fields manually bharein.'}`);
    }
    setUploadingDoc(false);
  };

  const formatForDatePicker = (dateStr: string) => {
    if (!dateStr) return "";
    try {
      const parts = dateStr.match(/\d+/g);
      if (parts && parts.length >= 3) {
        const d = parts[0], m = parts[1], y = parts[2];
        if (y.length === 4) return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
        if (d.length === 4) return `${d}-${m.padStart(2, '0')}-${y.padStart(2, '0')}`;
      }
      return dateStr;
    } catch (e) { return ""; }
  };

  const triggerAIScan = () => {
    if (!scannedAIData) {
       alert("⚠️ Pehle document upload karein — upload ke saath Mamta AI scan apne aap chalta hai. Yeh button scanned data ko dobara fields me bharta hai.");
       return;
    }

    setAiScanning(true);
    
    setTimeout(() => {
      const findValue = (obj: any, searchKeys: string[]): string => {
        if (!obj || typeof obj !== 'object') return "";
        for (const k of Object.keys(obj)) {
          if (searchKeys.includes(k) && obj[k]) return String(obj[k]);
          if (typeof obj[k] === 'object') {
             const nestedResult = findValue(obj[k], searchKeys);
             if (nestedResult) return nestedResult;
          }
        }
        return "";
      };

      let rawDocNum = findValue(scannedAIData, ['documentNumber', 'Document No', 'Policy No', 'Application No', 'Vehicle No', 'receiptNo']);
      const rawAmount = findValue(scannedAIData, ['totalAmount', 'Amount', 'Amounts', 'Total Fees Paid', 'Fees', 'fees']);
      const rawIssueDate = findValue(scannedAIData, ['documentDate', 'Date', 'Issue Date', 'issueDate']);
      const rawExpiryDate = findValue(scannedAIData, ['expiryDate', 'Expiry Date', 'Expiry Dates', 'nextDueDate', 'validUpto']);

      if (rawDocNum.startsWith(":")) rawDocNum = rawDocNum.substring(1); 
      
      const cleanDocNumber = rawDocNum.replace(/[^A-Za-z0-9/-]/g, '').trim();
      const cleanAmount = rawAmount.replace(/[^0-9.]/g, '');
      const formattedDate = formatForDatePicker(rawIssueDate);
      const formattedExpiryDate = formatForDatePicker(rawExpiryDate);

      setFormData(prev => ({
        ...prev,
        application_no: cleanDocNumber || prev.application_no || "",
        receipt_no: cleanDocNumber || prev.receipt_no || "",
        inspected_on: formattedDate || prev.inspected_on || "",
        amount: cleanAmount || prev.amount,
        payment_mode: cleanAmount ? "Online Transfer" : prev.payment_mode,
        next_due_date: formattedExpiryDate || prev.next_due_date || "" 
      }));
      
      setAiScanning(false);
      alert(`🤖 Mamta AI Scan Complete! Original Data Extracted & Formatted Successfully.`);
    }, 1000);
  };

  // 💾 PROPER ACCOUNTING SAVE TO FIREBASE
  const handleSave = async () => {
    if (!selectedVehicle) return;
    setSaving(true);
    try {
      const amount = parseFloat(formData.amount || '0') || 0;
      // A fee moves real money. The account is the operator's choice — this screen
      // refuses to guess one, and the server refuses the request without it.
      // Only a NEW fee needs an account named; see feeIsNew above.
      if (feeIsNew && !payAccount) {
        setSaving(false);
        return alert('⚠️ This document carries a fee of ₹' + amount.toLocaleString('en-IN')
          + '.\n\nSelect the bank or cash account it was paid from — the entry posts to the ledger and no account is assumed for you.');
      }

      const out = await fetchJson(`${MASTERS}/vehicle-documents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vehicle_id: selectedVehicle.id,
          doc_type: activeTab.id,
          doc_name: activeTab.name,
          application_no: cleanRef(formData.application_no) || null,
          receipt_no: cleanRef(formData.receipt_no) || null,
          inspected_on: formData.inspected_on || null,
          next_due_date: formData.next_due_date || null,
          amount: amount > 0 ? amount : null,
          payment_mode: formData.payment_mode || null,
          document_url: formData.document_file || null,
          // post_to_ledger=false is what keeps a redisplayed fee out of the
          // books. The amount still saves — it is part of the document's
          // record — it just does not raise a second voucher for money
          // that was already spent.
          post_to_ledger: feeIsNew,
          ...(feeIsNew ? { account: payAccount } : {}),
        }),
      });

      // Reload from the server rather than patching local state: next_due_date
      // also syncs an expiry column on the vehicle, and the compliance state and
      // days-to-expiry are computed there.
      await loadDocsFor(selectedVehicle.id);
      await fetchVehicles();
      setPayAccount('');

      alert(`✅ ${activeTab.name} saved.`
        + (out.voucher_id
          ? `\n\n📓 Fee of ₹${amount.toLocaleString('en-IN')} posted: Dr Vehicle Compliance & Docs / Cr ${payAccount}.`
          : amount > 0 ? '\n\nFee left as recorded - nothing posted, this fee was already paid.' : '\n\nNo fee recorded, so nothing was posted to the ledger.')
        + (out.ledger_note ? `\n\nℹ️ ${out.ledger_note}` : ''));
    } catch (error: any) {
      const hint = {
        NO_ACCOUNT: 'Select the account the fee was paid from.',
        OVERDRAFT: 'That account does not hold enough for this fee.',
      }[error.code];
      alert(`❌ ${hint ?? 'Document not saved.'}\n\n${error.message}`);
    }
    setSaving(false);
  };

  // 🌟 UNIVERSAL DRIVE LINK EXTRACTOR
  // WHERE A DOCUMENT ACTUALLY LIVES NOW.
  //
  // This used to assume Google Drive and parse a file id out of `/d/` or `id=`.
  // Drive went with Firebase; documents are stored by the API and served from
  // GET /api/v1/files/<key>. A Drive-shaped parse of a LOCAL key finds no id,
  // falls through to returning the raw string, and yields a Download button
  // pointing at a relative path that resolves against the SPA route — which is
  // why "Download" opened the dashboard instead of a PDF.
  //
  // Drive links still work, because documents filed before the cutover carry
  // them. New ones take the API path, and ?download=1 is what makes the browser
  // save the file instead of rendering it inline.
  const getDriveLinks = (rawLink: string) => {
    if (!rawLink) return { view: '#', download: '#', kind: 'none' };

    let fileId = '';
    try {
      if (rawLink.includes('drive.google.com')) {
        if (rawLink.includes('/d/')) fileId = rawLink.split('/d/')[1].split('/')[0];
        else if (rawLink.includes('id=')) fileId = rawLink.split('id=')[1].split('&')[0];
      }
    } catch (e) { console.error('Link Parse Error', e); }
    if (fileId) {
      return {
        view: `https://drive.google.com/file/d/${fileId}/preview`,
        download: `https://drive.google.com/uc?export=download&id=${fileId}`,
        kind: 'drive',
      };
    }

    // Already absolute (an S3 presign, say) — used as-is.
    if (/^https?:\/\//i.test(rawLink)) {
      return { view: rawLink, download: rawLink, kind: 'external' };
    }

    // A stored key. Normalise so the same key works whether it was saved as
    // "vehicle-docs/x.pdf" or "/api/v1/files/vehicle-docs/x.pdf".
    const key = rawLink.replace(/^\/+/, '').replace(/^api\/v1\/files\//, '');
    const base = `${API_BASE}/api/v1/files/${key}`;
    return { view: base, download: `${base}?download=1`, kind: 'stored' };
  };

  // A link that goes OUT has to be reachable from the recipient's phone.
  // API_BASE is 127.0.0.1 in development, and a loopback URL in a WhatsApp
  // message is a link that works for nobody. Say so rather than sending a dead
  // link and letting the driver find out at the checkpost.
  const shareableLink = (link: string) => {
    const url = getDriveLinks(link).view;
    return { url, reachable: !/^https?:\/\/(127\.0\.0\.1|localhost)/i.test(url) };
  };

  const shareBody = (docName: string, link: string, expiry: string) => {
    const vNo = plateOf(selectedVehicle);
    const { url, reachable } = shareableLink(link);
    const text = [
      `Vehicle Document: ${docName}`,
      `Vehicle: ${vNo}`,
      `Valid till: ${expiry || 'not recorded'}`,
      '',
      reachable
        ? `View / download: ${url}`
        : `(Link is only reachable inside the office network: ${url})`,
      '',
      '- Prasad Transport System',
    ].join('\n');
    return { vNo, url, reachable, text };
  };

  const warnIfUnreachable = (reachable: boolean, where: string) =>
    reachable || confirm(
      `This document link points at the office network and will not open ${where}. Send anyway?`);

  const shareDocument = (docName: string, link: string, expiry: string) => {
    if (!link) return alert('No document file found to share.');
    const { vNo, url, reachable } = shareBody(docName, link, expiry);
    if (!warnIfUnreachable(reachable, 'on a phone outside it')) return;
    const message = `📄 *Vehicle Document Alert*\n\n🚛 Vehicle: *${vNo}*\n🔖 Document: *${docName}*\n📅 Valid Till: *${expiry || 'N/A'}*\n\n📂 View/Download Document here:\n${url}\n\n- Prasad Transport System`;
    window.open(`https://wa.me/?text=${encodeURIComponent(message)}`, '_blank');
  };

  const emailDocument = (docName: string, link: string, expiry: string) => {
    if (!link) return alert('No document file found to share.');
    const { vNo, reachable, text } = shareBody(docName, link, expiry);
    if (!warnIfUnreachable(reachable, 'outside it')) return;
    const subject = `${vNo} — ${docName}${expiry ? ` (valid till ${expiry})` : ''}`;
    // mailto opens whatever mail client the operator already uses. Sending
    // server-side would need an SMTP account this ERP does not have, and
    // inventing one is not a UI change.
    window.location.href =
      `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`;
  };

  const uniqueOwners = Array.from(new Set(vehicles.filter(v => v.own_attach === 'Attached' && v.owner_name).map(v => v.owner_name)));

  const filteredVehicles = vehicles.filter(v => {
    const vNo = plateOf(v).toLowerCase();
    if (!vNo) return false; // records with no plate at all — nothing to file docs against
    const matchesSearch = vNo.includes(searchTerm.toLowerCase());
    const matchesCompany = filterCompany ? (v.company_name || v.Company_Name || v.company) === filterCompany : true;
    const matchesOwner = filterOwner ? (filterOwner === 'Own' ? v.own_attach === 'Own' : v.owner_name === filterOwner) : true;
    return matchesSearch && matchesCompany && matchesOwner;
  });

  return (
    <div style={{ padding: 'clamp(12px, 3vw, 30px)', minHeight: '100vh', background: 'radial-gradient(circle at top left, #0f172a, #020617)' }}>
      <style>{`
        .modern-input { background: rgba(15, 23, 42, 0.6); border: 1px solid rgba(51, 65, 85, 0.8); border-radius: 10px; color: white; padding: 12px 16px; outline: none; width: 100%; box-sizing: border-box; font-size: 14px;}
        .modern-input:focus { border-color: #38bdf8; box-shadow: 0 0 15px rgba(56, 189, 248, 0.3); background: rgba(15, 23, 42, 0.9); }
        .vehicle-card { background: rgba(30, 41, 59, 0.5); border: 1px solid rgba(255,255,255,0.05); padding: 25px; border-radius: 15px; cursor: pointer; transition: 0.3s; }
        .vehicle-card:hover { background: rgba(56, 189, 248, 0.1); transform: translateY(-5px); border-color: #38bdf8; box-shadow: 0 10px 20px rgba(56,189,248,0.1); }
        .upload-area { border: 2px dashed #475569; padding: 25px; border-radius: 15px; text-align: center; background: rgba(255,255,255,0.02); transition: 0.3s; }
        .upload-area:hover { border-color: #38bdf8; background: rgba(56,189,248,0.05); }
        .portal-btn { background: #1e293b; border: 1px solid #334155; color: #38bdf8; padding: 10px; border-radius: 8px; cursor: pointer; text-decoration: none; display: block; text-align: center; margin-bottom: 10px; font-size: 12px; font-weight: bold; }
        .portal-btn:hover { background: #38bdf8; color: #000; }
        .action-btn { background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); color: #fff; padding: 10px 15px; border-radius: 8px; cursor: pointer; font-size: 12px; font-weight: bold; transition: 0.2s; display: flex; align-items: center; gap: 8px; text-decoration: none;}
        .action-btn:hover { background: rgba(255,255,255,0.2); transform: scale(1.05); }
        .docs-filters { display: flex; gap: 15px; margin-bottom: 30px; background: rgba(30, 41, 59, 0.4); padding: 20px; border-radius: 15px; border: 1px solid rgba(255,255,255,0.05); }
        .camera-btn { background: #059669; color: white; border: none; border-radius: 10px; padding: 12px 18px; font-weight: bold; cursor: pointer; min-height: 44px; }

        /* 📱 MOBILE: the 3-column vault becomes a stacked, full-screen sheet */
        @media (max-width: 900px) {
          .docs-filters { flex-direction: column; gap: 10px; padding: 12px; }
          .vault-overlay { align-items: stretch !important; }
          .vault-shell { flex-direction: column; width: 100% !important; max-width: 100% !important; height: 100dvh !important; border-radius: 0 !important; }
          .vault-side { width: 100% !important; max-height: 30dvh; border-right: none !important; border-bottom: 1px solid #334155; padding: 15px !important; }
          .vault-side h3 { font-size: 20px !important; }
          .vault-main { padding: 18px !important; padding-bottom: 30px !important; }
          .vault-main h2 { font-size: 20px !important; }
          .vault-help { display: none; } /* helper portals are desktop-only chrome */
          .form-grid { grid-template-columns: 1fr !important; gap: 15px !important; }
          .vault-header { flex-direction: column; align-items: flex-start !important; gap: 12px; }
        }
      `}</style>

      {/* ── COMPLIANCE & EXPIRY ALERTS ─────────────────────────────────────
          Anything expired or inside the alert window, lorries and drivers
          alike. Hidden entirely when nothing is due, so it means something
          when it does appear. */}
      {alerts && alerts.alerts?.length > 0 && (() => {
        const expired = alerts.alerts.filter((a: any) => a.status === 'EXPIRED');
        const soon = alerts.alerts.filter((a: any) => a.status === 'EXPIRING');
        return (
          <div style={{ marginBottom: '22px', background: 'rgba(239,68,68,0.07)', border: '1px solid #ef4444',
                        borderRadius: '15px', padding: '18px 22px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap', marginBottom: '14px' }}>
              <span style={{ fontSize: '18px', fontWeight: 900, color: '#fff' }}>⚠️ Compliance &amp; Expiry Alerts</span>
              <span style={{ background: '#ef4444', color: '#fff', borderRadius: '20px', padding: '3px 12px', fontSize: '12px', fontWeight: 'bold' }}>
                {expired.length} EXPIRED
              </span>
              <span style={{ background: '#f59e0b', color: '#111', borderRadius: '20px', padding: '3px 12px', fontSize: '12px', fontWeight: 'bold' }}>
                {soon.length} within {alerts.alert_window_days} days
              </span>
              <span style={{ color: '#94a3b8', fontSize: '11px' }}>as at {alerts.as_of}</span>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                <thead>
                  <tr style={{ color: '#94a3b8', textAlign: 'left', fontSize: '11px', textTransform: 'uppercase' }}>
                    <th style={{ padding: '6px 10px' }}>Vehicle / Driver</th>
                    <th style={{ padding: '6px 10px' }}>Document</th>
                    <th style={{ padding: '6px 10px' }}>Expiry Date</th>
                    <th style={{ padding: '6px 10px', textAlign: 'right' }}>Days Left</th>
                    <th style={{ padding: '6px 10px' }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {alerts.alerts.slice(0, 25).map((a: any, i: number) => {
                    const red = a.status === 'EXPIRED';
                    return (
                      <tr key={i} style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                        <td style={{ padding: '8px 10px', color: '#fff', fontWeight: 'bold' }}>
                          {a.subject}
                          <span style={{ color: '#64748b', fontSize: '10px', marginLeft: '8px' }}>
                            {a.subject_kind === 'DRIVER' ? 'driver' : 'vehicle'}
                          </span>
                        </td>
                        <td style={{ padding: '8px 10px', color: '#cbd5e1' }}>{String(a.doc_type).replace(/_/g, ' ')}</td>
                        <td style={{ padding: '8px 10px', color: '#cbd5e1' }}>{a.expires_on}</td>
                        <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 900,
                                     color: red ? '#ef4444' : '#f59e0b' }}>
                          {a.days_left < 0 ? `${Math.abs(a.days_left)} overdue` : a.days_left}
                        </td>
                        <td style={{ padding: '8px 10px' }}>
                          <span style={{ background: red ? '#ef4444' : '#f59e0b', color: red ? '#fff' : '#111',
                                         borderRadius: '6px', padding: '2px 10px', fontSize: '11px', fontWeight: 'bold' }}>
                            {a.status}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })()}

      {/* Paperwork the bulk importer could not place. It sits above the vault
          deliberately: an unfiled document is work outstanding, and a queue put
          below the fold is a queue nobody clears. */}
      {/* Absence first, then the work queue, then the vault itself: a lorry
          with no paperwork is a bigger problem than one whose PUC expires in a
          week, and the expiry strip above cannot see it at all. */}
      {/* Zero-Gap: what the system TRIED and could not finish, above what it
          found. A broken process outranks a missing document, because the
          missing document may only be missing because the process broke. */}
      {/* A broken server outranks a broken process, which outranks a missing
          document. Scoped to PRASAD: this screen never shows Jaiswal's box. */}
      <WatchdogWidget company="PRASAD" />

      <DepartmentQueue />

      <ComplianceGapsWidget />

      <UnmappedDocumentQueue vehicles={vehicles} drivers={drivers} onAssigned={fetchVehicles} />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '30px' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 'clamp(24px, 5vw, 38px)', color: '#fff', fontWeight: '900', letterSpacing: '-1px' }}>📂 Fleet Document Vault</h2>
          <p style={{ color: '#94a3b8', fontSize: '15px' }}>Upload, Track Expiry, and Auto-sync to P&L Expenses.</p>
        </div>
      </div>

      <div className="docs-filters">
        <div style={{ flex: 1, position: 'relative' }}>
          <input placeholder="Search Vehicle No..." className="modern-input" style={{ paddingLeft: '45px' }} onChange={(e) => setSearchTerm(e.target.value)} />
          <span style={{ position: 'absolute', left: '15px', top: '12px', fontSize: '18px' }}>🔍</span>
        </div>
        <select className="modern-input" style={{ flex: 1 }} value={filterCompany} onChange={(e) => setFilterCompany(e.target.value)}>
          <option value="">🏢 All Companies</option>
          {companies.map((c, i) => <option key={i} value={c.company_name || c.Company_Name}>{c.company_name || c.Company_Name}</option>)}
        </select>
        <select className="modern-input" style={{ flex: 1 }} value={filterOwner} onChange={(e) => setFilterOwner(e.target.value)}>
          <option value="">👤 All Owners</option>
          <option value="Own" style={{ color: '#10b981', fontWeight: 'bold' }}>⭐ Only Own Assets</option>
          {uniqueOwners.map((owner: any, i: number) => <option key={i} value={owner}>🤝 {owner}</option>)}
        </select>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: '50px', color: '#38bdf8', fontSize: '20px', fontWeight: 'bold' }}>Loading Database...</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 300px), 1fr))', gap: 'clamp(14px, 2.5vw, 25px)' }}>
          {filteredVehicles.map((v) => {
            // THE BADGE COUNTED A FIELD THAT DOES NOT EXIST.
            //
            // `v.documents` was the Firestore nested map. PostgreSQL keeps
            // documents in their own table and the vehicle row has never
            // carried it, so this read undefined and every folder in the fleet
            // said "0 Docs Updated" — before the restore and after it, on all
            // 49 lorries. It was never a stale count; it was the wrong source.
            // doc_count now arrives with the row, like trip_count next to it.
            const updatedDocs = Number(v.doc_count ?? (v.documents ? Object.keys(v.documents).length : 0)) || 0;
            const statusColor = updatedDocs >= 10 ? '#10b981' : updatedDocs > 0 ? '#f59e0b' : '#ef4444';

            return (
              <div key={v.id} className="vehicle-card" onClick={() => loadVehicleDocs(v)}>
                <div style={{ fontSize: '35px', marginBottom: '15px' }}>📁</div>
                <h3 style={{ margin: '0 0 5px 0', color: '#fff', fontSize: '24px', fontWeight: '900' }}>{plateOf(v) || 'Unknown Plate'}</h3>
                <p style={{ margin: '0', color: v.own_attach === 'Own' ? '#10b981' : '#f59e0b', fontSize: '13px', fontWeight: 'bold' }}>
                  {v.own_attach} Asset {v.owner_name && `• ${v.owner_name}`}
                </p>
                <div style={{ marginTop: '20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '15px' }}>
                  <span style={{ fontSize: '12px', color: '#94a3b8' }}>Compliance Status</span>
                  <span style={{ background: statusColor + '20', color: statusColor, padding: '4px 10px', borderRadius: '8px', fontSize: '12px', fontWeight: 'bold' }}>
                    {updatedDocs} Docs Updated
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {selectedVehicle && (
        <div className="vault-overlay" style={{ position: 'fixed', inset: 0, background: 'rgba(2, 6, 23, 0.95)', backdropFilter: 'blur(10px)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div className="vault-shell" style={{ width: '95%', maxWidth: '1400px', height: '90vh', background: '#0f172a', borderRadius: '20px', border: '1px solid #38bdf8', display: 'flex', overflow: 'hidden', boxShadow: '0 20px 50px rgba(0,0,0,0.8)' }}>

            <div className="vault-side" style={{ width: '350px', background: '#1e293b', padding: '30px 20px', borderRight: '1px solid #334155', overflowY: 'auto' }}>
              <h3 style={{ color: '#38bdf8', margin: '0 0 5px 0', fontSize: '26px', fontWeight: '900' }}>{plateOf(selectedVehicle)}</h3>
              <p style={{ color: '#94a3b8', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '30px' }}>Master Document Vault</p>
              
              {docTypes.map((tab) => {
                const docData = selectedVehicle.documents && selectedVehicle.documents[tab.id];
                const isUpdated = !!docData;
                
                let dateColor = '#94a3b8';
                if(isUpdated && docData.next_due_date) {
                   // toISODate handles legacy DD-MM-YYYY strings that new Date() misparses
                   const expDate = new Date(toISODate(docData.next_due_date) || docData.next_due_date);
                   const today = new Date();
                   if (expDate < today) dateColor = '#ef4444'; 
                   else if ((expDate.getTime() - today.getTime()) / (1000 * 3600 * 24) < 15) dateColor = '#f59e0b'; 
                   else dateColor = '#10b981'; 
                }

                return (
                  <div 
                    key={tab.id} 
                    onClick={() => handleTabChange(tab)}
                    style={{ 
                      padding: '12px 15px', marginBottom: '10px', cursor: 'pointer', borderRadius: '12px', display: 'flex', flexDirection: 'column',
                      background: activeTab.id === tab.id ? 'rgba(56, 189, 248, 0.15)' : 'transparent',
                      borderLeft: activeTab.id === tab.id ? '4px solid #38bdf8' : '4px solid transparent',
                      color: activeTab.id === tab.id ? '#fff' : '#cbd5e1',
                      transition: '0.2s'
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: '13px', fontWeight: activeTab.id === tab.id ? 'bold' : 'normal' }}>{tab.name}</span>
                      {isUpdated && <span style={{ fontSize: '12px', background: 'rgba(16,185,129,0.2)', color: '#10b981', padding: '2px 6px', borderRadius: '5px' }}>✅</span>}
                    </div>
                    {isUpdated && (
                       <div style={{ fontSize: '11px', color: dateColor, marginTop: '5px', fontWeight: 'bold' }}>
                         Valid: {getVal(docData, ['inspected_on', 'issue_date', 'date'], '?')} ➔ {getVal(docData, ['next_due_date', 'expiry_date'], '?')}
                       </div>
                    )}
                  </div>
                )
              })}

              <div style={{ marginTop: '20px', borderTop: '1px dashed #475569', paddingTop: '20px' }}>
                 <input 
                   type="text" 
                   value={newDocName} 
                   onChange={(e) => setNewDocName(e.target.value)} 
                   placeholder="e.g. Police Verification..." 
                   style={{ width: '100%', padding: '10px', background: '#0f172a', border: '1px solid #38bdf8', color: '#fff', borderRadius: '6px', fontSize: '12px', marginBottom: '10px', outline: 'none' }}
                 />
                 <button onClick={handleAddCustomDoc} style={{ width: '100%', background: 'rgba(56, 189, 248, 0.1)', color: '#38bdf8', border: '1px dashed #38bdf8', padding: '10px', borderRadius: '6px', cursor: 'pointer', fontSize: '12px', fontWeight: 'bold' }}>
                   ➕ Add New Document
                 </button>
              </div>
            </div>

            <div className="vault-main" style={{ flex: 1, padding: '40px', overflowY: 'auto', position: 'relative' }}>
              <button onClick={() => setSelectedVehicle(null)} style={{ position: 'absolute', top: '20px', right: '20px', background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', border: '1px solid #ef4444', padding: '8px 15px', borderRadius: '10px', cursor: 'pointer', fontWeight: 'bold' }}>Close ✕</button>

              <div className="vault-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '40px', borderBottom: '1px solid #334155', paddingBottom: '20px' }}>
                <div>
                  <h2 style={{ color: 'white', margin: 0, fontSize: '28px' }}>{activeTab.name.replace(/[0-9.]/g, '').trim()} <span style={{color: '#38bdf8'}}>Details</span></h2>
                </div>
                
                <button
                  onClick={triggerAIScan}
                  disabled={aiScanning || !scannedAIData}
                  title={scannedAIData ? 'Re-apply scanned values to the form' : 'Upload a document below — scan runs automatically'}
                  style={{
                    background: scannedAIData ? 'linear-gradient(135deg, #10b981, #059669)' : '#334155',
                    color: scannedAIData ? 'white' : '#94a3b8',
                    border: 'none', padding: '12px 25px', borderRadius: '30px', fontWeight: 'bold', cursor: scannedAIData ? 'pointer' : 'not-allowed', display: 'flex', alignItems: 'center', gap: '8px', minHeight: '44px'
                  }}
                >
                  {aiScanning ? '⏳ Extracting Data...' : '🤖 Mamta AI Scan'}
                </button>
              </div>

              <div className="form-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '25px' }}>
                <div>
                  <label style={{ color: '#94a3b8', fontSize: '11px', fontWeight: 'bold', textTransform: 'uppercase', marginBottom: '8px', display: 'block' }}>Application / Policy No</label>
                  <input className="modern-input" name="application_no" value={formData.application_no || ''} onChange={handleInputChange} placeholder="e.g. APP-12345" />
                </div>
                <div>
                  <label style={{ color: '#94a3b8', fontSize: '11px', fontWeight: 'bold', textTransform: 'uppercase', marginBottom: '8px', display: 'block' }}>Receipt / Challan No</label>
                  <input className="modern-input" name="receipt_no" value={formData.receipt_no || ''} onChange={handleInputChange} placeholder="e.g. REC-9908" />
                </div>
                <div>
                  <label style={{ color: '#94a3b8', fontSize: '11px', fontWeight: 'bold', textTransform: 'uppercase', marginBottom: '8px', display: 'block' }}>Issue Date (Valid From)</label>
                  <input type="date" className="modern-input" name="inspected_on" value={formData.inspected_on || ''} onChange={handleInputChange} style={{colorScheme:'dark'}} />
                </div>
                <div>
                  <label style={{ color: '#f59e0b', fontSize: '11px', fontWeight: 'bold', textTransform: 'uppercase', marginBottom: '8px', display: 'block' }}>Next Expiry Date *</label>
                  <input type="date" className="modern-input" name="next_due_date" value={formData.next_due_date || ''} onChange={handleInputChange} style={{colorScheme:'dark', border: '1px solid #f59e0b', background: 'rgba(245,158,11,0.05)'}} />
                </div>
                <div>
                  <label style={{ color: '#ef4444', fontSize: '11px', fontWeight: 'bold', textTransform: 'uppercase', marginBottom: '8px', display: 'block' }}>Total Fees Paid (₹)</label>
                  <input type="number" className="modern-input" name="amount" value={formData.amount || ''} onChange={handleInputChange} placeholder="Posts to the ledger" style={{border: '1px solid #ef4444', background: 'rgba(239,68,68,0.05)', fontWeight: 'bold'}} />
                </div>
                <div>
                  <label style={{ color: '#94a3b8', fontSize: '11px', fontWeight: 'bold', textTransform: 'uppercase', marginBottom: '8px', display: 'block' }}>Payment Mode</label>
                  <select className="modern-input" name="payment_mode" value={formData.payment_mode || ''} onChange={handleInputChange}>
                    <option value="">-- Select Mode --</option>
                    <option value="Online Transfer">Online Transfer</option>
                    <option value="Cash">Cash</option>
                    <option value="Card">Card</option>
                  </select>
                </div>
              </div>

              {/* 💳 PAID FROM — required whenever a fee is entered.
                  A compliance fee is real money leaving a real account, so the
                  operator names it. Nothing is defaulted: the old screen wrote a
                  one-sided debit with no credit at all, which PostgreSQL will not
                  accept (ledger_entries is append-only with a deferred Dr = Cr
                  constraint per voucher). */}
              {feeIsNew && (
                <div style={{ marginTop: '25px', background: 'rgba(239,68,68,0.06)', border: '1px solid #ef4444', borderRadius: '14px', padding: '18px' }}>
                  <label style={{ color: '#ef4444', fontSize: '12px', fontWeight: 900, textTransform: 'uppercase', display: 'block', marginBottom: '8px' }}>
                    💳 Paid From — Bank / Cash Account *
                  </label>
                  <select className="modern-input" value={payAccount} onChange={(e) => setPayAccount(e.target.value)}
                    style={{ border: `1px solid ${payAccount ? '#10b981' : '#ef4444'}`, fontWeight: 'bold' }}>
                    <option value="">-- Select the account this fee was paid from --</option>
                    {accounts.map((a: any) => (
                      <option key={a.ledger_name} value={a.ledger_name}>
                        {a.ledger_name} — ₹{Number(a.balance || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                      </option>
                    ))}
                  </select>
                  <div style={{ color: '#94a3b8', fontSize: '12px', marginTop: '10px', lineHeight: 1.6 }}>
                    On save this posts a payment voucher:
                    {' '}<b style={{ color: '#f87171' }}>Dr Vehicle Compliance &amp; Docs</b>
                    {' '}/ <b style={{ color: '#34d399' }}>Cr {payAccount || 'the account you select'}</b>
                    {' '}for ₹{Number(formData.amount || 0).toLocaleString('en-IN')}.
                    {formData._voucher_id && (
                      <div style={{ color: '#fbbf24', marginTop: 6 }}>
                        ℹ️ A fee for this document is already posted (voucher {String(formData._voucher_id).slice(0, 8)}…). Re-saving will not post it twice.
                      </div>
                    )}
                  </div>
                </div>
              )}

              <div className="upload-area" style={{ marginTop: '35px' }}>
                <label style={{ color: '#38bdf8', fontSize: '16px', fontWeight: 'bold', display: 'block', marginBottom: '15px' }}>📎 Upload Original PDF/IMG (saved to secure Storage + Mamta AI scan)</label>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '15px', flexWrap: 'wrap' }}>
                  <button className="camera-btn" onClick={() => document.getElementById('vd-camera-input')?.click()}>📸 Photo Kheencho</button>
                  <input id="vd-camera-input" type="file" accept="image/*" capture="environment" onChange={handleFileUpload} style={{ display: 'none' }} />
                  <input type="file" accept="image/*,.pdf" onChange={handleFileUpload} style={{ color: '#94a3b8', background: '#1e293b', padding: '10px', borderRadius: '10px', maxWidth: '100%' }} />
                  {uploadingDoc && <span style={{ color: '#f59e0b', fontWeight: 'bold' }}>⏳ Uploading + Mamta AI scan…</span>}
                </div>
                
                {/* 🌟 FILE PREVIEW BUTTONS */}
                {formData.document_file && !uploadingDoc && (
                  <div style={{ marginTop: '20px', padding: '15px', background: 'rgba(16,185,129,0.1)', border: '1px dashed #10b981', borderRadius: '10px', display: 'inline-block' }}>
                     <p style={{ margin: '0 0 10px 0', color: '#10b981', fontWeight: 'bold', fontSize: '13px' }}>✅ File Available</p>
                     <div style={{ display: 'flex', gap: '15px', flexWrap: 'wrap', justifyContent: 'center' }}>
                       {/* A stored PDF is served from the token-guarded file
                           route, so a plain <a href> lands on a 401 and paints a
                           blank tab. openDocument fetches it WITH the bearer and
                           opens the bytes; Drive/Firebase links still open direct. */}
                       <button type="button" onClick={() => openDocument(formData.document_file)} className="action-btn" style={{ borderColor: '#38bdf8', color: '#38bdf8', background: 'rgba(56, 189, 248, 0.1)' }}>👁️ View Document</button>
                       <button type="button" onClick={() => openDocument(formData.document_file, { download: true })} className="action-btn" style={{ borderColor: '#f59e0b', color: '#f59e0b', background: 'rgba(245, 158, 11, 0.1)' }}>⬇️ Download PDF</button>
                       <button onClick={() => emailDocument(activeTab.name, formData.document_file, formData.next_due_date)} className="action-btn" style={{ borderColor: '#a78bfa', color: '#a78bfa', background: 'rgba(167, 139, 250, 0.1)' }}>✉️ Share via Email</button>
                       <button onClick={() => shareDocument(activeTab.name, formData.document_file, formData.next_due_date)} className="action-btn" style={{ borderColor: '#22c55e', color: '#22c55e', background: 'rgba(34, 197, 94, 0.1)' }}>💬 Share via WhatsApp</button>
                     </div>
                  </div>
                )}
              </div>

              <button onClick={handleSave} disabled={saving} style={{ width: '100%', marginTop: '35px', padding: '18px', background: 'linear-gradient(135deg, #3b82f6, #6366f1)', color: 'white', border: 'none', borderRadius: '12px', fontSize: '18px', fontWeight: '900', cursor: 'pointer', boxShadow: '0 10px 20px rgba(59,130,246,0.4)', transition: '0.3s' }}>
                {saving ? '⏳ Syncing with Server...' : '💾 SAVE DOCUMENT & UPDATE EXPENSE LEDGER'}
              </button>

            </div>

            <div className="vault-help" style={{ width: '250px', background: '#020617', padding: '25px', borderLeft: '1px solid #1e293b' }}>
               <h4 style={{color:'#fff', marginBottom:'20px'}}>🌐 Helper Portals</h4>
               {portals.map((p, i) => (
                  <a key={i} href={p.url} target="_blank" rel="noreferrer" className="portal-btn">{p.name} ↗</a>
               ))}
               <button onClick={() => setSelectedVehicle(null)} style={{width:'100%', marginTop:'60px', padding:'12px', background:'#ef444422', color:'#ef4444', border:'1px solid #ef4444', borderRadius:'8px', cursor:'pointer', fontWeight: 'bold'}}>Close Vault</button>
            </div>

          </div>
        </div>
      )}
    </div>
  );
}