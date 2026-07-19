// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { collection, getDocs, doc, updateDoc, addDoc, deleteDoc, Timestamp, query, orderBy, limit, where } from 'firebase/firestore';
import { db } from './firebase';
import { extractLoadingSlip } from './lib/aiScanner';
import { parseDocDate } from './lib/postTripEngine';
import { speak } from './lib/voice/tts';

export default function LodingDetals() {
  const [activeTab, setActiveTab] = useState('MANUAL'); 
  const [trips, setTrips] = useState<any[]>([]);
  const [rtkmMaster, setRtkmMaster] = useState<any[]>([]); 
  const [vehicles, setVehicles] = useState<any[]>([]);
  const [drivers, setDrivers] = useState<any[]>([]);
  
  const [vehicleLinks, setVehicleLinks] = useState<any[]>([]); 
  const [customers, setCustomers] = useState<any[]>([]);
  
  // 🏢 Company Master Data State
  const [companyMasterData, setCompanyMasterData] = useState<any[]>([]);
  
  const [loading, setLoading] = useState(false);

  const [selectedTripId, setSelectedTripId] = useState('');
  const [isNewEntry, setIsNewEntry] = useState(true); 
  const [isScanningFile, setIsScanningFile] = useState(false);
  const [scanLowConf, setScanLowConf] = useState<string[]>([]); // fields AI was unsure about

  const [showInboxModal, setShowInboxModal] = useState(false);
  const [isDragging, setIsDragging] = useState(false); 

  const [vehSearch, setVehSearch] = useState('');
  const [showVehDropdown, setShowVehDropdown] = useState(false);

  const [searchQuery, setSearchQuery] = useState('');
  const [companyFilter, setCompanyFilter] = useState('');

  const [routeSearchValue, setRouteSearchValue] = useState('');

  const [manualData, setManualData] = useState({
    Trip_ID: '', Customer: '', Loading_Date: new Date().toISOString().split('T')[0], Challan_No: '', 
    Loading_Point: '', Vehical_No: '', Registered_Assessee: '', Consignee_Name: '', 
    Product_Type: 'HSD', Loaded_Qty: '', RTKM: '', Rate: '', Driver_Name: '', Driver_Mobil_No: '',
    Invoice_URL: '', Operating_Company: '' 
  });

  useEffect(() => {
    fetchTripsAndMaster();
  }, []);

  // 🚀 AUTOMATIC TRIP ID GENERATOR TRIGGER (Runs whenever Operating_Company changes)
  useEffect(() => {
    if (isNewEntry && manualData.Operating_Company && trips.length >= 0) {
      generateSmartTripId(manualData.Operating_Company);
    }
  }, [manualData.Operating_Company, trips, isNewEntry]); 

  useEffect(() => {
    setVehSearch(manualData.Vehical_No || '');
  }, [manualData.Vehical_No]);

  useEffect(() => {
    const handlePaste = (e: any) => {
      if (showInboxModal && e.clipboardData && e.clipboardData.files.length > 0) {
        processFile(e.clipboardData.files[0]);
      }
    };
    document.addEventListener('paste', handlePaste);
    return () => document.removeEventListener('paste', handlePaste);
  }, [showInboxModal]);

  // 🧠 THE MAGIC: STRICT PREFIX MATCHING
  const generateSmartTripId = async (companyName: string) => {
    let prefix = 'TRP'; 
    const cNameUpper = companyName.trim().toUpperCase();
    
    if (cNameUpper.includes('PRASAD') && !cNameUpper.includes('GAUTAM')) prefix = 'PT';
    else if (cNameUpper.includes('JAISWAL')) prefix = 'JE';
    else if (cNameUpper.includes('GAUTAM')) prefix = 'GP';
    
    try {
      let highestNum = 0;
      trips.forEach(t => {
        const tId = String(t.Trip_ID || t.trip_id || '').trim().toUpperCase();
        if (tId.startsWith(prefix)) {
           const numPart = tId.replace(prefix, '');
           if (/^\d+$/.test(numPart)) {
             const parsedNum = parseInt(numPart, 10);
             if (parsedNum > highestNum) {
               highestNum = parsedNum;
             }
           }
        }
      });
      
      const nextNum = highestNum + 1;
      const formattedNum = String(nextNum).padStart(5, '0'); // e.g., PT00001
      const newSmartId = `${prefix}${formattedNum}`;
      
      setManualData(prev => ({ ...prev, Trip_ID: newSmartId }));
    } catch (e) {
      setManualData(prev => ({ ...prev, Trip_ID: `${prefix}${Math.floor(Math.random() * 90000 + 10000)}` }));
    }
  };

  const fetchTripsAndMaster = async () => {
    setLoading(true);
    try {
      const tripSnap = await getDocs(collection(db, "TRIPS"));
      setTrips(tripSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })));
      
      const rtkmMasterSnap = await getDocs(collection(db, "RTKM_MASTER")).catch(() => ({ docs: [] })); 
      setRtkmMaster(rtkmMasterSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })));

      const vehSnap = await getDocs(collection(db, "VEHICLES"));
      setVehicles(vehSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })));

      const drvSnap = await getDocs(collection(db, "DRIVERS"));
      setDrivers(drvSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })));

      const custSnap = await getDocs(collection(db, "CUSTOMERS")).catch(() => ({ docs: [] }));
      setCustomers(custSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })));

      const linkSnap = await getDocs(collection(db, "Vehicle_Assignments")).catch(() => ({ docs: [] }));
      setVehicleLinks(linkSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })));

      // 🏢 FETCH COMPANY MASTER DATA
      const cSnap1 = await getDocs(collection(db, "COMPANY")).catch(() => ({ docs: [] }));
      const cSnap2 = await getDocs(collection(db, "COMPANIES")).catch(() => ({ docs: [] }));
      const allComps = [...cSnap1.docs, ...cSnap2.docs].map(d => ({ id: d.id, ...d.data() }));
      setCompanyMasterData(allComps);

      if (allComps.length > 0 && !manualData.Operating_Company) {
         setManualData(prev => ({ ...prev, Operating_Company: allComps[0].company_name || allComps[0].name || allComps[0].Company_Name || 'PRASAD TRANSPORT' }));
      }

    } catch (error) {
      console.error("Error fetching data:", error);
    }
    setLoading(false);
  };

  const speakSmartHinglishReport = (text: string) => {
      speak(text); // 🔊 100% LOCAL voice (browser on-device TTS) — no cloud.
  };

  // 📅 Hardened AI-date parsing (shared engine): handles DD-MM-YYYY, DD/MM/YY,
  // DD.MM.YYYY (IOCL SAP), YYYY-MM-DD and day/month swaps — returns '' instead
  // of feeding an invalid string into the date picker.
  const formatForDatePicker = (dateStr: string) => parseDocDate(dateStr);

  const getVehicleDetails = (vNo: string) => {
    let dName = '';
    let dMobile = '';
    let opCompany = manualData.Operating_Company || 'PRASAD TRANSPORT'; 

    const cleanVno = (vNo || '').replace(/[^A-Z0-9]/ig, '').toUpperCase();
    
    const selectedVeh = vehicles.find(v => {
        const dbV1 = String(v.vehicle_no || v.Vehicle_No || v.VehicleNo || '').replace(/[^A-Z0-9]/ig, '').toUpperCase();
        const dbV2 = String(v.vehical_no || v.Vehical_No || v.VehicalNo || '').replace(/[^A-Z0-9]/ig, '').toUpperCase();
        const dbV3 = String(v.registration_no || v.Registration_No || v.RegistrationNo || v.registrationNo || '').replace(/[^A-Z0-9]/ig, '').toUpperCase();
        return dbV1 === cleanVno || dbV2 === cleanVno || dbV3 === cleanVno;
    });
    
    if (selectedVeh) {
       dName = selectedVeh.driver_name || selectedVeh.Driver_Name || selectedVeh.assigned_pilot || '';
       dMobile = selectedVeh.driver_mobile || selectedVeh.driver_mobil_no || selectedVeh.pilot_mobile || '';
       
       const vehString = JSON.stringify(selectedVeh).toUpperCase();
       // Try to auto-match company from vehicle data if it exists in master
       companyMasterData.forEach(c => {
         const cName = (c.company_name || c.name || '').toUpperCase();
         if (cName && vehString.includes(cName.replace('M/S ', '').replace('M/S. ', ''))) {
            opCompany = c.company_name || c.name;
         }
       });
    }

    const latestLink = vehicleLinks
      .filter(l => (l.vehicleName || '').replace(/[^A-Z0-9]/ig, '').toUpperCase() === cleanVno && l.status === 'LINKED')
      .sort((a, b) => new Date(b.assignedAt).getTime() - new Date(a.assignedAt).getTime())[0];

    if (latestLink) dName = latestLink.driverName;

    if (dName) {
       const drv = drivers.find(d => d.name === dName);
       if (drv) dMobile = drv.mobile_no || drv.mobile || drv.phone || dMobile;
    }

    return { dName, dMobile, opCompany };
  };

  const processFile = async (file: File) => {
    setIsScanningFile(true);
    setScanLowConf([]);
    try {
      // 🤖 100% LOCAL extraction via Gemma 4 vision (no cloud).
      const ex = await extractLoadingSlip(file);

      // Normalize product to the form's expected values.
      const p = (ex.product_type || '').toUpperCase();
      let product = 'HSD';
      if (p.includes('ATF') || p.includes('JET')) product = 'ATF';
      else if (p.includes('LPG')) product = 'LPG Bulk';
      else if (p === 'MS' || p.includes('PETROL')) product = 'MS';
      else if (p.includes('HSD') || p.includes('DIESEL')) product = 'HSD';

      const extractedVehicle = String(ex.vehicle_no || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
      const { dName, dMobile, opCompany } = getVehicleDetails(extractedVehicle || manualData.Vehical_No);

      setIsNewEntry(true);
      setSelectedTripId('NEW');

      setManualData(prev => {
        const isPartLoad = prev.Challan_No.trim().length > 0;
        return {
          ...prev,
          Operating_Company: opCompany || prev.Operating_Company,
          Loading_Date: formatForDatePicker(ex.document_date) || prev.Loading_Date,
          Challan_No: isPartLoad && ex.challan_no ? `${prev.Challan_No}, ${ex.challan_no}` : (ex.challan_no || prev.Challan_No),
          Vehical_No: extractedVehicle || prev.Vehical_No,
          Customer: ex.customer || prev.Customer,
          Loading_Point: ex.loading_point || prev.Loading_Point,
          Consignee_Name: ex.consignee_name || prev.Consignee_Name,
          Loaded_Qty: isPartLoad ? String(Number(prev.Loaded_Qty || 0) + Number(ex.loaded_qty || 0)) : String(ex.loaded_qty || ''),
          Product_Type: isPartLoad ? `${prev.Product_Type} + ${product} (Part Load)` : product,
          Driver_Name: ex.driver_name || dName || prev.Driver_Name,
          Driver_Mobil_No: dMobile || prev.Driver_Mobil_No,
        };
      });

      setScanLowConf(ex._lowConfidence || []);
      setActiveTab('MANUAL');
      setShowInboxModal(false);

      const note = ex._lowConfidence.length ? ' Kuch fields highlighted hain — unhe check karein.' : '';
      alert(`✅ Mamta AI (local Gemma 4) ne slip scan kar li. Kripya verify karke Save karein.${note}`);
      try { speakSmartHinglishReport(`नमस्कार सर। लोडिंग स्लिप लोकल ए आई से स्कैन हो गई है। कृपया चेक करके सेव करें।`); } catch (e) { /* voice optional */ }
    } catch (error: any) {
      const msg = String(error?.name === 'LLMOfflineError' || /ollama|engine|reach/i.test(error?.message || '')
        ? '❌ Local AI engine (Ollama) band hai. Use chalu karke dobara try karein.'
        : '❌ Document padha nahi gaya. Saaf photo/PDF se dobara try karein.');
      alert(msg);
    }
    setIsScanningFile(false);
  };

  const handleEditTrip = (t: any) => {
    setIsNewEntry(false);
    setSelectedTripId(t.id);
    setManualData({
      Trip_ID: t.Trip_ID || t.trip_id || t.id,
      Customer: t.Customer || t.customer_name || t.Registered_Assessee || '',
      Loading_Date: t.Loading_Date || t.loading_date || new Date().toISOString().split('T')[0],
      Challan_No: t.Challan_No || t.challan_no || '',
      Loading_Point: t.Loading_Point || t.loading_point || '',
      Vehical_No: t.Vehical_No || t.vehicle_no || t.vehical_no || '',
      Registered_Assessee: t.Registered_Assessee || t.customer_name || '',
      Consignee_Name: t.Consignee_Name || t.consignee_name || '',
      Product_Type: t.Product_Type || t.product_type || 'HSD',
      Loaded_Qty: t.Loaded_Qty || t.loaded_qty || t.driver_loaded_qty || '',
      RTKM: t.RTKM || t.rtkm || '',
      Rate: t.Rate || t.rate || '',
      Driver_Name: t.Driver_Name || t.driver_name || '',
      Driver_Mobil_No: t.Driver_Mobil_No || t.driver_mobil_no || t.driver_mobile || '',
      Operating_Company: t.Operating_Company || t.operating_company || companyMasterData[0]?.company_name || 'PRASAD TRANSPORT', 
      Invoice_URL: t.Invoice_URL || t.invoice_url || ''
    });
    setActiveTab('MANUAL');
    window.scrollTo({ top: 0, behavior: 'smooth' }); 
  };

  const handleDeleteTrip = async (id: string) => {
    if(window.confirm("⚠️ Are you sure you want to DELETE this loading entry? This cannot be undone!")) {
      try {
        await deleteDoc(doc(db, "TRIPS", id));
        alert("✅ Entry Deleted Successfully!");
        fetchTripsAndMaster();
      } catch (e) { alert("❌ Error deleting entry."); }
    }
  };

  const handleManualFileUpload = (e: any) => {
    if (e.target.files && e.target.files[0]) processFile(e.target.files[0]);
  };

  const handleDragOver = (e: any) => { e.preventDefault(); setIsDragging(true); };
  const handleDragLeave = (e: any) => { e.preventDefault(); setIsDragging(false); };
  const handleDrop = (e: any) => {
    e.preventDefault(); setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) processFile(e.dataTransfer.files[0]);
  };

  const handleManualTripSelect = (e: any) => {
    const tId = e.target.value;
    setSelectedTripId(tId);
    
    if (tId === 'NEW') {
      setIsNewEntry(true);
      const defaultComp = companyMasterData[0]?.company_name || companyMasterData[0]?.name || 'PRASAD TRANSPORT';
      setManualData({
        Trip_ID: '', 
        Customer: '', Loading_Date: new Date().toISOString().split('T')[0], Challan_No: '', 
        Loading_Point: '', Vehical_No: '', Registered_Assessee: '', Consignee_Name: '', 
        Product_Type: 'HSD', Loaded_Qty: '', RTKM: '', Rate: '', Driver_Name: '', Driver_Mobil_No: '', 
        Operating_Company: defaultComp, Invoice_URL: ''
      });
      generateSmartTripId(defaultComp); 
      setRouteSearchValue(''); 
    } else if (tId) {
      const t = trips.find(trip => trip.id === tId);
      if(t) handleEditTrip(t);
    }
  };

  const handleVehicleBlur = () => {
    setTimeout(() => setShowVehDropdown(false), 200);
    if (vehSearch) {
        // 🔥 This will find details and also detect the operating company based on vehicle
        const { dName, dMobile, opCompany } = getVehicleDetails(vehSearch.toUpperCase());
        setManualData(prev => ({ 
            ...prev, 
            Vehical_No: vehSearch.toUpperCase(), 
            Driver_Name: dName || prev.Driver_Name, 
            Driver_Mobil_No: dMobile || prev.Driver_Mobil_No, 
            Operating_Company: opCompany // 🔄 Company updates -> Triggers ID Gen
        }));
    }
  };

  const handleVehicleSelect = (vNo: string) => {
    setVehSearch(vNo);
    setShowVehDropdown(false);
    const { dName, dMobile, opCompany } = getVehicleDetails(vNo);
    setManualData(prev => ({ 
      ...prev, Vehical_No: vNo, Driver_Name: dName, Driver_Mobil_No: dMobile, Operating_Company: opCompany 
    }));
  };

  const handleRouteSearchChange = (val: string) => {
    setRouteSearchValue(val);
    const [depotStr, consigneeStr] = val.split('➔').map(s => s?.trim());
    if(!consigneeStr) return;
    const consigneeClean = consigneeStr.split('|')[0].trim();
    
    const selectedRoute = rtkmMaster.find(r => 
        (r.Consignee_Name || r.consignee_name || '') === consigneeClean &&
        (r.Depot_Link || r.depot_link || '') === depotStr
    );
    
    if (selectedRoute) {
      setManualData(prev => ({
        ...prev,
        Loading_Point: selectedRoute.Depot_Link || selectedRoute.depot_link || '',
        Consignee_Name: selectedRoute.Consignee_Name || selectedRoute.consignee_name || '',
        Customer: selectedRoute.Registered_Assessee || selectedRoute.customer_name || '',
        Registered_Assessee: selectedRoute.Registered_Assessee || selectedRoute.customer_name || '',
        RTKM: selectedRoute.RTKM_Distance || selectedRoute.rtkm_distance || '',
        Rate: selectedRoute.Rate_Per_Unit || selectedRoute.rate_per_unit || '',
        Product_Type: selectedRoute.Item_Type || selectedRoute.item_type || 'HSD'
      }));
    }
  };

  const handleDriverSelect = (e: any) => {
    const dName = e.target.value;
    const selectedDriver = drivers.find(d => d.name === dName);
    setManualData(prev => ({
      ...prev, Driver_Name: dName,
      Driver_Mobil_No: selectedDriver ? (selectedDriver.mobile_no || selectedDriver.mobile || selectedDriver.phone || '') : ''
    }));
  };

  const handleOperatingCompanyChange = (e: any) => {
     const comp = e.target.value;
     // 🔄 Changing company here manually triggers ID Gen Effect
     setManualData(prev => ({...prev, Operating_Company: comp}));
  };

  const handleApproveDriverLoading = async (tripId: string, driverQty: string) => {
    try {
      await updateDoc(doc(db, "TRIPS", tripId), {
        office_approved_loading: true, Loaded_Qty: driverQty, loaded_qty: driverQty,
        trip_status: 'IN_TRANSIT', Loading_Date: new Date().toISOString().split('T')[0],
        loading_date: new Date().toISOString().split('T')[0], sort_date: new Date().toISOString().split('T')[0], sync_to_customer_portal: true
      });
      alert("✅ Driver Loading Data Approved! Synced to Customer Portal.");
      fetchTripsAndMaster();
    } catch (e) { alert("❌ Error approving data."); }
  };

  const handleManualSave = async () => {
    // 📋 POST-TRIP WORKFLOW: Loaded Qty ab MANDATORY NAHI — exact qty/rate company
    // challan/invoice ke saath baad me aate hain aur billing screen par inline
    // bharte hain. Qty khali chhodo to 0 save hota hai (bill se pehle bharna hoga).
    if (!manualData.Challan_No || !manualData.Vehical_No) return alert("⚠️ Please enter Vehicle No and Challan No!");
    if (!manualData.Loaded_Qty && !window.confirm("ℹ️ Loaded Qty khali hai — 0 save hoga.\n\nQty/Rate baad me Company Challan aane par Billing screen se bhar sakte hain. Continue?")) return;

    try {
      if (isNewEntry) {
        await addDoc(collection(db, "TRIPS"), {
          ...manualData, trip_id: manualData.Trip_ID, vehicle_no: manualData.Vehical_No, 
          customer_name: manualData.Customer, loading_point: manualData.Loading_Point,
          consignee_name: manualData.Consignee_Name, driver_name: manualData.Driver_Name,
          driver_mobil_no: manualData.Driver_Mobil_No, loaded_qty: manualData.Loaded_Qty || '0',
          loading_date: manualData.Loading_Date, challan_no: manualData.Challan_No,
          operating_company: manualData.Operating_Company, invoice_url: manualData.Invoice_URL, 
          office_approved_loading: true, trip_status: 'IN_TRANSIT', sync_to_customer_portal: true,
          sort_date: manualData.Loading_Date || new Date().toISOString().split('T')[0],
          created_at: Timestamp.now()
        });
        alert(`✅ Entry Saved for ${manualData.Operating_Company}! LR No: ${manualData.Trip_ID}`);
      } else {
        await updateDoc(doc(db, "TRIPS", selectedTripId), {
          ...manualData, office_approved_loading: true, trip_status: 'IN_TRANSIT',
          sort_date: manualData.Loading_Date || new Date().toISOString().split('T')[0],
          loaded_qty: manualData.Loaded_Qty || '0', loading_date: manualData.Loading_Date,
          challan_no: manualData.Challan_No, loading_point: manualData.Loading_Point, 
          consignee_name: manualData.Consignee_Name, operating_company: manualData.Operating_Company, 
          invoice_url: manualData.Invoice_URL, sync_to_customer_portal: true 
        });
        alert("✅ Loading Entry Updated Successfully!");
      }
      setSelectedTripId(''); setIsNewEntry(true);
      generateSmartTripId(manualData.Operating_Company); 
      setRouteSearchValue(''); fetchTripsAndMaster();
    } catch (e) { alert("❌ Error saving manual entry."); }
  };

  const sendCustomerWhatsApp = (trip: any) => {
    const customerName = trip.Customer || trip.customer_name || trip.Registered_Assessee;
    if(!customerName) return alert("⚠️ No Customer Name found!");
    const foundCustomer = customers.find(c => c.company_name?.toUpperCase() === customerName.toUpperCase() || c.name?.toUpperCase() === customerName.toUpperCase());
    let mobile = foundCustomer?.mobile || foundCustomer?.phone || '';
    if (!mobile) {
       const promptMobile = window.prompt(`Customer "${customerName}" ka mobile number database mein nahi mila.\nWhatsApp bhejney ke liye kripya number enter karein:`);
       if(!promptMobile) return;
       mobile = promptMobile;
    }
    const company = trip.Operating_Company || trip.operating_company || 'Prasad Transport';
    const invoiceLink = trip.invoice_url || trip.Invoice_URL ? `\n*Invoice/LR PDF:* ${trip.invoice_url || trip.Invoice_URL}` : '';
    const message = `🏢 *${company.toUpperCase()} - DISPATCH ALERT*\n\nDear ${customerName},\nYour material has been loaded and dispatched successfully.\n\n*LR / Trip ID:* ${trip.Trip_ID || trip.trip_id}\n*Vehicle:* ${trip.Vehical_No || trip.vehicle_no || trip.vehical_no}\n*Product:* ${trip.Product_Type || 'Material'}\n*Loaded Qty:* ${trip.Loaded_Qty || trip.loaded_qty || trip.driver_loaded_qty}\n*Challan No:* ${trip.Challan_No || trip.challan_no || '-'}\n\n*From:* ${trip.Loading_Point || trip.loading_point}\n*To:* ${trip.Consignee_Name || trip.consignee_name}${invoiceLink}\n\nYou can track this live on your Customer Portal.\n\nRegards,\n${company} Team`;
    let phone = mobile.replace(/\s+/g, ''); 
    if (phone.length === 10) phone = '91' + phone;
    window.open(`https://wa.me/${phone}?text=${encodeURIComponent(message)}`, '_blank');
  };

  // 🖨️ 4-COPY MULTI-PAGE PDF GENERATOR (FIXED COMPANY NAME - NO PT/JE PREFIX)
  const generateAndSavePDF = (trip: any) => {
    const printWindow = window.open('', '_blank');
    if (!printWindow) return alert("Please allow popups to generate PDF.");

    const copies = ['CONSIGNOR COPY', 'CONSIGNEE COPY', 'TRANSPORTER COPY', 'OFFICE COPY'];

    const tripId = trip.Trip_ID || trip.trip_id || 'N/A';
    const date = trip.Loading_Date || trip.loading_date || 'N/A';
    const vehicle = trip.Vehical_No || trip.vehicle_no || trip.vehical_no || 'N/A';
    const driver = trip.Driver_Name || trip.driver_name || 'N/A';
    const mobile = trip.Driver_Mobil_No || trip.driver_mobil_no || trip.driver_mobile || '-';
    const customer = trip.Customer || trip.customer_name || trip.Registered_Assessee || 'N/A';
    const from = trip.Loading_Point || trip.loading_point || 'N/A';
    const toName = trip.Consignee_Name || trip.consignee_name || 'N/A';
    const product = trip.Product_Type || trip.product_type || 'N/A';
    const qty = trip.Loaded_Qty || trip.loaded_qty || trip.driver_loaded_qty || 'N/A';
    const rate = trip.Rate || trip.rate || '';
    const freight = trip.gross_freight || trip.Gross_Freight || '';
    const challan = trip.Challan_No || trip.challan_no || '-';
    
    // 🏢 PULL COMPANY MASTER DETAILS
    const printCompany = trip.Operating_Company || trip.operating_company || 'M/S PRASAD TRANSPORT';

    const compDetails = companyMasterData.find(c => {
       const cName = String(c.company_name || c.name || c.Company_Name || '').toUpperCase();
       return cName.includes(printCompany.toUpperCase()) || printCompany.toUpperCase().includes(cName);
    }) || {};

    const companyNameFull = compDetails.company_name || compDetails.name || printCompany;
    const cAddress = compDetails.address || compDetails.Full_Address || 'H/No. 622, R/ No. 101, W/No. 12, Chapaguri Road';
    const cCity = compDetails.city || compDetails.City || 'North Bongaigaon';
    const cState = compDetails.state || compDetails.State || 'Assam';
    const cPin = compDetails.pincode || compDetails.pin || '783380';
    const cMobile = compDetails.phone || compDetails.phone_number || compDetails.mobile || '9435021201, 9435022586';
    const cEmail = compDetails.email || compDetails.email_address || 'support@prasadtransport.com';
    const cGST = compDetails.gstin || compDetails.gst_no || compDetails.GSTIN || '18AAKFP2339R2ZG';
    const cPAN = compDetails.pan || compDetails.pan_no || compDetails.PAN || 'AAKFP2339R';
    const cWebsite = compDetails.website || 'www.prasadtransport.com';

    // REMOVED THE "PT" / "JE" INITIALS LOGIC HERE
    const cleanName = companyNameFull.toUpperCase().replace('M/S ', '').replace('M/S. ', '');
    const nameParts = cleanName.split(' ');
    const p1 = nameParts[0] || ''; 
    const p2 = nameParts.slice(1).join(' ') || '';

    let allPagesHtml = '';

    copies.forEach((copyName, index) => {
      allPagesHtml += `
        <div style="border: 2px solid black; width: 100%; box-sizing: border-box; font-family: Arial, sans-serif; font-size: 12px; margin-bottom: 20px; page-break-inside: avoid;">
          
          <div style="display: flex; border-bottom: 2px solid black; padding: 10px;">
            <div style="flex: 7;">
               <h1 style="margin: 0; font-size: 32px; color: #1e3a8a; font-style: italic; letter-spacing: 2px;">${p1}</h1>
               <div style="font-weight: bold; margin-top: 5px;">${p2}</div>
               <div style="font-weight: bold; margin-top: 5px;">Fleet Owner & Transport Contractor</div>
               <div>${cAddress},</div>
               <div>${cCity}, ${cState} - ${cPin}</div>
               <div><strong>GST No. : ${cGST} , PAN No. : ${cPAN}</strong></div>
            </div>
            <div style="flex: 5; text-align: right; font-size: 11px; line-height: 1.4;">
               <div>Mobile : ${cMobile}</div>
               <div>E-mail : ${cEmail}</div>
               <div>Website : ${cWebsite}</div>
            </div>
          </div>

          <div style="display: flex; border-bottom: 1px solid black;">
            <div style="flex: 1; border-right: 1px solid black; padding: 5px;"><strong>C/N NO. -</strong> <span style="color:red; font-size: 14px;">${tripId}</span></div>
            <div style="flex: 1; border-right: 1px solid black; padding: 5px;"><strong>DATE :</strong> ${date}</div>
            <div style="flex: 1; border-right: 1px solid black; padding: 5px;"><strong>FROM :</strong> ${from}</div>
            <div style="flex: 1; padding: 5px;"><strong>TO :</strong> ${toName}</div>
          </div>

          <div style="display: flex; border-bottom: 1px solid black; min-height: 80px;">
            <div style="flex: 1; border-right: 1px solid black; padding: 5px;">
               <strong>CONSIGNOR :</strong><br/>${customer}
            </div>
            <div style="flex: 1; padding: 5px;">
               <strong>CONSIGNEE :</strong><br/>${toName}
            </div>
          </div>
          <div style="display: flex; border-bottom: 1px solid black;">
            <div style="flex: 1; border-right: 1px solid black; padding: 5px;"><strong>GST No. :</strong> </div>
            <div style="flex: 1; padding: 5px;"><strong>GST No. :</strong> </div>
          </div>

          <table style="width: 100%; border-collapse: collapse; text-align: center;">
            <tr style="border-bottom: 1px solid black;">
               <th style="border-right: 1px solid black; padding: 5px;">PARTICULARS OF GOODS</th>
               <th style="border-right: 1px solid black; padding: 5px;">QUANTITY<br/>M.T./K.L</th>
               <th style="border-right: 1px solid black; padding: 5px;">RATE</th>
               <th style="border-right: 1px solid black; padding: 5px;">FREIGHT<br/>RS.</th>
               <th style="padding: 5px;">REMARKS</th>
            </tr>
            <tr style="height: 120px; vertical-align: top;">
               <td style="border-right: 1px solid black; padding: 5px; text-align: left;">${product}</td>
               <td style="border-right: 1px solid black; padding: 5px;">${qty}</td>
               <td style="border-right: 1px solid black; padding: 5px;">${rate}</td>
               <td style="border-right: 1px solid black; padding: 5px;">${freight}</td>
               <td style="padding: 5px; font-size: 11px; vertical-align: middle;">
                 Freight to be billed at Origin and to be paid by Consignor/Consignee
               </td>
            </tr>
          </table>

          <div style="border-top: 1px solid black; border-bottom: 1px solid black; padding: 5px;">
            <strong>PERSON LIABLE FOR SERVICE TAX : CONSIGNEE OR CONSIGNOR</strong>
          </div>
          <div style="border-bottom: 1px solid black; padding: 5px;">
            <strong>VEHICLE No. :</strong> ${vehicle}
          </div>

          <table style="width: 100%; border-collapse: collapse; text-align: center; border-bottom: 1px solid black;">
            <tr>
              <th style="border-right: 1px solid black; padding: 5px;">CHALLAN / INVOICE No.</th>
              <th style="border-right: 1px solid black; padding: 5px;">DATE</th>
              <th style="border-right: 1px solid black; padding: 5px;">VALUE</th>
              <th style="padding: 5px;">EWAY BILL No.</th>
            </tr>
            <tr>
              <td style="border-right: 1px solid black; padding: 5px;">${challan}</td>
              <td style="border-right: 1px solid black; padding: 5px;">${date}</td>
              <td style="border-right: 1px solid black; padding: 5px;">Rs.</td>
              <td style="padding: 5px;"></td>
            </tr>
          </table>

          <div style="padding: 5px; border-bottom: 1px solid black; font-size: 10px;">
            Received the goods for Transportation at OWNER'S RISK and not responsible for any Leakage / Breakage, subject to the Terms & condition overleaf
          </div>

          <div style="display: flex; padding: 5px; min-height: 100px;">
            <div style="flex: 1.5; border-right: 1px solid black; padding-right: 5px; font-size: 9px;">
              <strong>DECLARATION FOR CENVAT CREDIT</strong><br/>
              " We hereby certify that we have not availed credit of duty paid on inputs or capital goods under the provisions of Cenvat Credit Rules, 2004 nor here availed the benifit of Notification No. 12/2003-ST dated 20-06-2003"
            </div>
            <div style="flex: 1.5; border-right: 1px solid black; padding-left: 5px; padding-right: 5px; font-size: 11px;">
              <div>Driver's Name : ${driver}</div>
              <div>Licence No : </div>
              <div>Signature : </div>
              <div>Mobile No. : ${mobile}</div>
            </div>
            <div style="flex: 2; padding-left: 5px; text-align: center; position: relative;">
              <div style="font-size: 10px;">All Subject to ${cCity} Jurisdiction only</div>
              <div style="position: absolute; bottom: 5px; width: 100%; font-weight: bold; font-size: 14px;">${copyName}</div>
            </div>
            <div style="flex: 1.5; text-align: right; position: relative;">
              <div style="font-size: 11px;">For <strong>${companyNameFull}</strong></div>
              <div style="position: absolute; bottom: 5px; right: 0;">Authorized Signatory</div>
            </div>
          </div>
        </div>
      `;
      if (index < copies.length - 1) {
        allPagesHtml += '<div style="page-break-after: always;"></div>';
      }
    });

    const htmlWrapper = `
      <html>
        <head>
          <title>LR_${tripId}_All_Copies</title>
          <style>
             body { font-family: Arial, sans-serif; padding: 20px; color: #000; background: #ccc; }
             .wrapper { width: 800px; margin: 0 auto; background: white; padding: 20px; box-shadow: 0 0 10px rgba(0,0,0,0.2); }
             @media print {
               body { padding: 0; background: white; }
               .wrapper { width: 100%; margin: 0; box-shadow: none; padding: 0; }
             }
          </style>
        </head>
        <body>
          <div class="wrapper">
             ${allPagesHtml}
          </div>
          <script>
            window.onload = function() {
              setTimeout(function() { window.print(); }, 500);
            }
          </script>
        </body>
      </html>
    `;
    printWindow.document.write(htmlWrapper);
    printWindow.document.close();
  };

  const pendingDriverApprovals = trips.filter(t => t.driver_loaded_qty && !t.office_approved_loading);
  const pendingManualTrips = trips.filter(t => !t.office_approved_loading && t.trip_status !== 'COMPLETED');
  
  let filteredRegister = trips.filter(t => t.office_approved_loading);
  
  if (companyFilter) {
      filteredRegister = filteredRegister.filter(t => (t.Operating_Company || t.operating_company || 'PRASAD TRANSPORT').toUpperCase() === companyFilter.toUpperCase());
  }
  
  if (searchQuery) {
      const q = searchQuery.toLowerCase();
      filteredRegister = filteredRegister.filter(t => 
          (t.Trip_ID || '').toLowerCase().includes(q) || 
          (t.Vehical_No || t.vehicle_no || '').toLowerCase().includes(q) || 
          (t.Challan_No || '').toLowerCase().includes(q) ||
          (t.Customer || '').toLowerCase().includes(q)
      );
  }

  filteredRegister = filteredRegister.sort((a:any, b:any) => new Date(b.Loading_Date || b.loading_date).getTime() - new Date(a.Loading_Date || a.loading_date).getTime());

  const inputStyle = { width: '100%', padding: '10px', background: '#0f172a', border: '1px solid #475569', color: '#fff', borderRadius: '8px', fontSize: '13px', boxSizing: 'border-box' as const, outline: 'none' };
  const autoFillStyle = { ...inputStyle, background: 'rgba(56, 189, 248, 0.05)', border: '1px dashed #38bdf8', color: '#94a3b8' };

  return (
    <div style={{ color: 'white', fontFamily: "'Inter', sans-serif", paddingBottom: '50px' }}>
      
      {showInboxModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(2, 6, 23, 0.9)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#0f172a', border: '1px solid #38bdf8', width: '90%', maxWidth: '600px', borderRadius: '20px', padding: '30px', boxShadow: '0 0 40px rgba(56, 189, 248, 0.2)' }}>
            
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', borderBottom: '1px solid #1e293b', paddingBottom: '15px' }}>
              <h2 style={{ margin: 0, color: '#38bdf8', fontSize: '24px' }}>📥 Smart Document Inbox</h2>
              <button onClick={() => setShowInboxModal(false)} style={{ background: 'transparent', border: 'none', color: '#ef4444', fontSize: '24px', cursor: 'pointer' }}>✖</button>
            </div>

            <p style={{ color: '#cbd5e1', fontSize: '14px', marginBottom: '25px', lineHeight: '1.6' }}>
              Open Gmail, and simply <b>drag & drop</b> the PDF here, or copy an image and press <b>Ctrl+V (Paste)</b> anywhere on this screen!
            </p>

            <div style={{ background: 'rgba(245, 158, 11, 0.1)', border: '1px dashed #f59e0b', padding: '20px', borderRadius: '12px', marginBottom: '20px' }}>
              <h4 style={{ color: '#f59e0b', margin: '0 0 10px 0' }}>Step 1: Open Email</h4>
              <button 
                onClick={() => window.open('https://mail.google.com', '_blank')}
                style={{ background: '#f59e0b', color: '#0f172a', border: 'none', padding: '10px 20px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px' }}
              >
                📧 Open Webmail (Gmail)
              </button>
            </div>

            <div 
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              style={{ 
                background: isDragging ? 'rgba(56, 189, 248, 0.2)' : 'rgba(16, 185, 129, 0.1)', 
                border: isDragging ? '2px dashed #38bdf8' : '2px dashed #10b981', 
                padding: '40px 20px', 
                borderRadius: '12px',
                textAlign: 'center',
                transition: 'all 0.3s'
              }}
            >
              <h4 style={{ color: isDragging ? '#38bdf8' : '#10b981', margin: '0 0 10px 0', fontSize: '18px' }}>
                {isScanningFile ? '⏳ Scanning... Please Wait' : 'Step 2: Drop PDF Here or Press Ctrl+V'}
              </h4>
              <label style={{ display: 'inline-block', marginTop: '10px', color: '#cbd5e1', cursor: isScanningFile ? 'not-allowed' : 'pointer', fontWeight: 'bold', background: 'rgba(255,255,255,0.1)', padding: '10px 20px', borderRadius: '8px' }}>
                Or click to browse file...
                <input type="file" accept="image/*,.pdf" style={{ display: 'none' }} onChange={handleManualFileUpload} disabled={isScanningFile} />
              </label>
            </div>

          </div>
        </div>
      )}


      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '25px' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '28px', color: '#fff', display: 'flex', alignItems: 'center', gap: '10px' }}>📦 Loading Register</h2>
          <p style={{ margin: '5px 0 0 0', color: '#94a3b8', fontSize: '14px' }}>Smart Linked with Customer Portal, Auto LR Gen & AI Scan</p>
        </div>
        
        <button 
          onClick={() => setShowInboxModal(true)} 
          style={{ 
            background: 'linear-gradient(135deg, #3b82f6, #8b5cf6)', color: '#fff', border: 'none', padding: '12px 25px', 
            borderRadius: '30px', fontWeight: '900', cursor: 'pointer', fontSize: '14px', 
            boxShadow: '0 5px 20px rgba(139, 92, 246, 0.4)', display: 'flex', alignItems: 'center', gap: '8px', transition: '0.3s' 
          }}
        >
          📥 Smart Inbox (Email & Scan)
        </button>
      </div>

      <div style={{ display: 'flex', gap: '10px', marginBottom: '25px', borderBottom: '1px solid #334155', paddingBottom: '10px' }}>
        <button onClick={() => setActiveTab('MANUAL')} style={{ padding: '10px 20px', background: activeTab === 'MANUAL' ? 'rgba(16, 185, 129, 0.1)' : 'transparent', color: activeTab === 'MANUAL' ? '#10b981' : '#94a3b8', border: 'none', borderBottom: activeTab === 'MANUAL' ? '3px solid #10b981' : '3px solid transparent', fontWeight: 'bold', cursor: 'pointer', transition: '0.3s' }}>✍️ DIRECT ENTRY</button>
        <button onClick={() => setActiveTab('AUTO')} style={{ padding: '10px 20px', background: activeTab === 'AUTO' ? 'rgba(56, 189, 248, 0.1)' : 'transparent', color: activeTab === 'AUTO' ? '#38bdf8' : '#94a3b8', border: 'none', borderBottom: activeTab === 'AUTO' ? '3px solid #38bdf8' : '3px solid transparent', fontWeight: 'bold', cursor: 'pointer', transition: '0.3s' }}>📱 APP SYNC {pendingDriverApprovals.length > 0 && <span style={{background:'#ef4444', color:'white', padding:'2px 8px', borderRadius:'10px', marginLeft:'5px', fontSize:'11px'}}>{pendingDriverApprovals.length}</span>}</button>
        <button onClick={() => setActiveTab('REGISTER')} style={{ padding: '10px 20px', background: activeTab === 'REGISTER' ? 'rgba(245, 158, 11, 0.1)' : 'transparent', color: activeTab === 'REGISTER' ? '#f59e0b' : '#94a3b8', border: 'none', borderBottom: activeTab === 'REGISTER' ? '3px solid #f59e0b' : '3px solid transparent', fontWeight: 'bold', cursor: 'pointer', transition: '0.3s' }}>📋 SHEET VIEW</button>
      </div>

      {activeTab === 'MANUAL' && (
        <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: '15px', padding: '30px' }}>
          
          <div style={{ marginBottom: '20px', background: 'rgba(16, 185, 129, 0.05)', padding: '15px', borderRadius: '10px', border: '1px solid rgba(16, 185, 129, 0.2)' }}>
            <label style={{ color: '#10b981', fontSize: '13px', fontWeight: 'bold', marginBottom: '8px', display: 'block' }}>🔍 Start Loading Entry *</label>
            <select value={selectedTripId} onChange={handleManualTripSelect} style={{ width: '100%', padding: '12px', background: '#0f172a', border: '1px solid #10b981', color: '#fff', borderRadius: '8px', outline: 'none', fontSize: '15px' }}>
              <option value="">-- Choose Option --</option>
              <option value="NEW" style={{ background: '#10b981', color: '#0f172a', fontWeight: 'bold' }}>➕ CREATE FRESH DIRECT ENTRY</option>
              <optgroup label="Auto-Fill from Pending Trips:">
                {pendingManualTrips.map(t => <option key={t.id} value={t.id}>{t.vehicle_no || t.vehical_no} | {t.loading_point} ➔ {t.consignee_name}</option>)}
              </optgroup>
            </select>
          </div>

          {selectedTripId === 'NEW' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '15px', marginBottom: '20px', background: 'rgba(56, 189, 248, 0.05)', padding: '15px', border: '1px dashed #38bdf8', borderRadius: '10px' }}>
              <div style={{ flex: 1 }}>
                <label style={{ color: '#38bdf8', fontSize: '14px', fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>🤖 Mamta AI Scanner <span style={{ fontSize: '10px', color: '#10b981', border: '1px solid #10b981', borderRadius: '10px', padding: '1px 6px', marginLeft: '4px' }}>100% LOCAL</span></label>
                <p style={{ margin: 0, color: '#94a3b8', fontSize: '12px' }}>Upload Invoice or Loading Slip (PDF/Photo) — read on-device by Gemma 4, no internet. Auto-fills the form below.</p>
              </div>
              <label style={{ background: '#38bdf8', color: '#0f172a', padding: '10px 20px', borderRadius: '8px', fontWeight: 'bold', cursor: isScanningFile ? 'not-allowed' : 'pointer', fontSize: '13px', transition: '0.3s', boxShadow: '0 4px 15px rgba(56,189,248,0.4)' }}>
                {isScanningFile ? '⏳ Scanning File...' : '📎 Upload & Scan'}
                <input type="file" accept="image/*,.pdf" style={{ display: 'none' }} onChange={handleManualFileUpload} disabled={isScanningFile} />
              </label>
              {manualData.Invoice_URL && <span style={{ color: '#10b981', fontSize: '18px' }}>✅ PDF Saved!</span>}
            </div>
          )}

          {selectedTripId && (
            <>
              {isNewEntry && (
                <div style={{ background: 'rgba(245,158,11,0.1)', padding: '15px', borderRadius: '8px', marginBottom: '20px', border: '1px dashed #f59e0b' }}>
                  <label style={{ color: '#f59e0b', fontSize: '13px', fontWeight: 'bold', display: 'block', marginBottom: '8px' }}>🔗 1. Search & Select Route from RTKM Master (Optional)</label>
                  <input 
                    list="master-route-list" 
                    placeholder="🔍 Type Depot or Consignee to Search Route..." 
                    value={routeSearchValue} 
                    onChange={(e) => handleRouteSearchChange(e.target.value)} 
                    style={{ width: '100%', padding: '12px', background: '#0f172a', border: '1px solid #f59e0b', color: '#fff', borderRadius: '8px', outline: 'none' }} 
                    autoComplete="off"
                  />
                  <datalist id="master-route-list">
                    {rtkmMaster.map(r => (
                      <option key={r.id} value={`${r.Depot_Link || r.depot_link} ➔ ${r.Consignee_Name || r.consignee_name} | Rate: ₹${r.Rate_Per_Unit || r.rate_per_unit || '0'}`} />
                    ))}
                  </datalist>
                </div>
              )}

              <h4 style={{ color: '#38bdf8', borderBottom: '1px solid #334155', paddingBottom: '10px', marginBottom: '15px' }}>2. Verify / Edit Details</h4>

              {scanLowConf.length > 0 && (
                <div style={{ background: 'rgba(245,158,11,0.1)', border: '1px solid #f59e0b', borderRadius: '8px', padding: '10px 14px', marginBottom: '15px', fontSize: '12px', color: '#f59e0b' }}>
                  ⚠️ AI in fields ko padh nahi paaya — kripya manually check karein: <b>{scanLowConf.join(', ')}</b>
                </div>
              )}
              
              <div style={{ marginBottom: '15px' }}>
                <label style={{ color: '#f59e0b', fontSize: '11px', display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>Operating Company (For Auto LR Generation) *</label>
                <select value={manualData.Operating_Company} onChange={handleOperatingCompanyChange} style={{...inputStyle, borderColor: '#f59e0b'}}>
                  {companyMasterData.map(c => <option key={c.id} value={c.company_name || c.name}>{c.company_name || c.name}</option>)}
                </select>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '15px', marginBottom: '20px' }}>
                
                <div>
                  <label style={{ color: '#94a3b8', fontSize: '11px', display: 'block', marginBottom: '5px' }}>LR No / Trip ID (Auto-Generated)</label>
                  <input type="text" value={manualData.Trip_ID} readOnly style={autoFillStyle} title="Auto Generated based on Company Selection" />
                </div>
                
                <div style={{ position: 'relative' }}>
                  <label style={{ color: '#38bdf8', fontSize: '11px', display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>Vehicle No * 🔍</label>
                  <input
                    type="text"
                    value={vehSearch}
                    onChange={(e) => {
                      setVehSearch(e.target.value.toUpperCase());
                      setShowVehDropdown(true);
                      setManualData(prev => ({...prev, Vehical_No: e.target.value.toUpperCase()}));
                    }}
                    onFocus={() => setShowVehDropdown(true)}
                    onBlur={handleVehicleBlur}
                    style={{ ...inputStyle, borderColor: '#38bdf8' }}
                    placeholder="Type to search..."
                    autoComplete="off"
                  />
                  {showVehDropdown && vehSearch.length > 0 && (
                    <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: '#0f172a', border: '1px solid #38bdf8', zIndex: 999, maxHeight: '200px', overflowY: 'auto', borderRadius: '8px', marginTop: '5px', boxShadow: '0 10px 25px rgba(0,0,0,0.5)' }}>
                      {vehicles.filter(v => (v.vehicle_no||v.vehical_no||'').toUpperCase().includes(vehSearch.toUpperCase())).length > 0 ? (
                        vehicles.filter(v => (v.vehicle_no||v.vehical_no||'').toUpperCase().includes(vehSearch.toUpperCase())).map((v, i) => (
                          <div key={i} style={{ padding: '12px 15px', cursor: 'pointer', borderBottom: '1px solid #1e293b', color: '#fff', fontSize: '13px', fontWeight: 'bold' }}
                               onMouseDown={() => handleVehicleSelect(v.vehicle_no || v.vehical_no)}>
                            🚛 {v.vehicle_no || v.vehical_no}
                          </div>
                        ))
                      ) : (
                        <div style={{ padding: '12px', color: '#64748b', fontSize: '12px' }}>No vehicle found...</div>
                      )}
                    </div>
                  )}
                </div>

                <div>
                  <label style={{ color: '#94a3b8', fontSize: '11px', display: 'block', marginBottom: '5px' }}>Driver Name</label>
                  <select value={manualData.Driver_Name} onChange={handleDriverSelect} style={inputStyle}>
                    <option value="">-- Select Driver --</option>
                    {drivers.map(d => <option key={d.id} value={d.name}>{d.name}</option>)}
                  </select>
                </div>

                <div><label style={{ color: '#94a3b8', fontSize: '11px', display: 'block', marginBottom: '5px' }}>Driver Mobile</label><input type="text" value={manualData.Driver_Mobil_No} onChange={e=>setManualData({...manualData, Driver_Mobil_No: e.target.value})} style={inputStyle} /></div>
                
                <div>
                  <label style={{ color: '#f59e0b', fontSize: '11px', display: 'block', marginBottom: '5px' }}>Customer Name (Billed To)</label>
                  <input type="text" list="customer-list" value={manualData.Customer} onChange={e=>setManualData({...manualData, Customer: e.target.value})} style={inputStyle} placeholder="E.g. ABC Steel Corp" />
                  <datalist id="customer-list">
                    {customers.map(c => <option key={c.id} value={c.company_name || c.name} />)}
                  </datalist>
                </div>
                
                <div><label style={{ color: '#f59e0b', fontSize: '11px', display: 'block', marginBottom: '5px' }}>Loading Point</label><input type="text" value={manualData.Loading_Point} onChange={e=>setManualData({...manualData, Loading_Point: e.target.value})} style={inputStyle} /></div>
                <div><label style={{ color: '#f59e0b', fontSize: '11px', display: 'block', marginBottom: '5px' }}>Consignee / Destination</label><input type="text" value={manualData.Consignee_Name} onChange={e=>setManualData({...manualData, Consignee_Name: e.target.value})} style={inputStyle} /></div>
                <div><label style={{ color: '#f59e0b', fontSize: '11px', display: 'block', marginBottom: '5px' }}>RTKM (Distance)</label><input type="text" value={manualData.RTKM} onChange={e=>setManualData({...manualData, RTKM: e.target.value})} style={inputStyle} /></div>
                <div><label style={{ color: '#f59e0b', fontSize: '11px', display: 'block', marginBottom: '5px' }}>Rate / Freight</label><input type="text" value={manualData.Rate} onChange={e=>setManualData({...manualData, Rate: e.target.value})} style={inputStyle} /></div>
              </div>

              <h4 style={{ color: '#10b981', borderBottom: '1px solid #334155', paddingBottom: '10px', marginBottom: '15px' }}>3. Enter Loading Quantity</h4>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '15px', marginBottom: '25px' }}>
                <div>
                  <label style={{ color: '#fff', fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>Loading Date *</label>
                  <input type="date" value={manualData.Loading_Date} onChange={e => setManualData({...manualData, Loading_Date: e.target.value})} style={{ ...inputStyle, colorScheme: 'dark' }} />
                </div>
                <div>
                  <label style={{ color: '#fff', fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>Challan / Invoice No *</label>
                  <input type="text" value={manualData.Challan_No} onChange={e => setManualData({...manualData, Challan_No: e.target.value})} style={{ ...inputStyle, borderColor: '#f59e0b' }} placeholder="Enter Challan No" />
                </div>
                <div>
                  <label style={{ color: '#fff', fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>Product Type / Material *</label>
                  <select value={manualData.Product_Type} onChange={e => setManualData({...manualData, Product_Type: e.target.value})} style={inputStyle}>
                    <option value="HSD">HSD (Diesel)</option>
                    <option value="MS">MS (Petrol)</option>
                    <option value="MS + HSD (Part Load)">MS + HSD (Part Load)</option>
                    <option value="ATF">ATF</option>
                    <option value="LPG Bulk">LPG Bulk</option> 
                    <option value="LPG Cylinder">LPG Cylinder</option>
                    <option value="Iron/Steel">Iron/Steel (Pipes, TMT)</option>
                    <option value="Cement/Coal">Cement / Coal</option>
                    <option value="FMCG">FMCG / General Goods</option>
                    <option value="Other">Other</option>
                  </select>
                </div>
                <div>
                  <label style={{ color: '#10b981', fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>Loaded Qty / Weight *</label>
                  <input type="number" value={manualData.Loaded_Qty} onChange={e => setManualData({...manualData, Loaded_Qty: e.target.value})} style={{ ...inputStyle, borderColor: '#10b981', fontSize: '16px', fontWeight: 'bold', color: '#10b981' }} placeholder="0.00" />
                </div>
              </div>

              <button onClick={handleManualSave} style={{ width: '100%', background: 'linear-gradient(135deg, #10b981, #059669)', color: '#fff', border: 'none', padding: '15px', borderRadius: '8px', fontWeight: '900', cursor: 'pointer', fontSize: '16px', boxShadow: '0 5px 15px rgba(16,185,129,0.4)' }}>
                {isNewEntry ? `💾 Save & Generate LR: ${manualData.Trip_ID}` : '💾 Save Update'}
              </button>
            </>
          )}
        </div>
      )}

      {activeTab === 'AUTO' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '20px' }}>
          {pendingDriverApprovals.length === 0 ? <div style={{ color: '#64748b' }}>No pending approvals.</div> : 
            pendingDriverApprovals.map(t => (
              <div key={t.id} style={{ background: '#1e293b', border: '1px solid #38bdf8', borderRadius: '15px', padding: '20px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                  <span style={{ color: '#38bdf8', fontWeight: 'bold', fontSize: '18px' }}>{t.Vehical_No || t.vehicle_no}</span>
                  <span style={{ background: '#334155', padding: '2px 8px', borderRadius: '5px', fontSize: '11px' }}>{t.Trip_ID || t.trip_id}</span>
                </div>
                <div style={{ marginBottom: '10px' }}><span className="pt-pill pt-pill--loading">Loading</span></div>
                <div style={{ color: '#94a3b8', fontSize: '13px', marginBottom: '15px' }}>📍 {t.Loading_Point || t.loading_point} ➔ {t.Consignee_Name || t.consignee_name}</div>
                <div style={{ background: 'rgba(56, 189, 248, 0.1)', padding: '15px', borderRadius: '10px', marginBottom: '15px' }}>
                  <div style={{ fontSize: '12px', color: '#94a3b8' }}>Driver Qty:</div>
                  <div style={{ fontSize: '24px', fontWeight: '900', color: '#38bdf8' }}>{t.driver_loaded_qty}</div>
                </div>
                <button onClick={() => handleApproveDriverLoading(t.id, t.driver_loaded_qty)} style={{ width: '100%', background: '#38bdf8', color: '#0f172a', border: 'none', padding: '12px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer' }}>✅ Verify & Sync to Customer Portal</button>
              </div>
          ))}
        </div>
      )}

      {activeTab === 'REGISTER' && (
        <div style={{ background: '#1e293b', borderRadius: '15px', padding: '20px', border: '1px solid #334155' }}>
          
          <div style={{ display: 'flex', gap: '15px', marginBottom: '20px' }}>
            <input 
              type="text" 
              placeholder="🔍 Search Vehicle, Challan, Trip ID, LR No..." 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{ ...inputStyle, flex: 2, borderColor: '#38bdf8' }}
            />
            <select 
              value={companyFilter} 
              onChange={(e) => setCompanyFilter(e.target.value)} 
              style={{ ...inputStyle, flex: 1, borderColor: '#f59e0b', color: '#f59e0b' }}
            >
              <option value="">🏢 All Companies</option>
              {companyMasterData.map(c => <option key={c.id} value={c.company_name || c.name}>{c.company_name || c.name}</option>)}
            </select>
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', whiteSpace: 'nowrap' }}>
              <thead style={{ background: '#0f172a', color: '#f59e0b', fontSize: '11px', textTransform: 'uppercase' }}>
                <tr>
                  <th style={{ padding: '15px' }}>LR No / Trip_ID</th>
                  <th style={{ padding: '15px', color: '#f59e0b' }}>Company</th>
                  <th style={{ padding: '15px', color: '#38bdf8' }}>Customer / Party</th>
                  <th style={{ padding: '15px' }}>Loading_Date</th>
                  <th style={{ padding: '15px' }}>Challan_No</th>
                  <th style={{ padding: '15px' }}>Loading_Point</th>
                  <th style={{ padding: '15px', color: '#38bdf8' }}>Vehical_No</th>
                  <th style={{ padding: '15px' }}>Consignee_Name</th>
                  <th style={{ padding: '15px' }}>Product_Type</th>
                  <th style={{ padding: '15px', color: '#10b981' }}>Loaded_Qty</th>
                  <th style={{ padding: '15px' }}>Driver_Name</th>
                  <th style={{ padding: '15px', textAlign: 'center' }}>✏️ Edit</th>
                  <th style={{ padding: '15px', textAlign: 'center' }}>🗑️ Delete</th>
                  <th style={{ padding: '15px', textAlign: 'center' }}>🖨️ Multi-Copy LR</th>
                  <th style={{ padding: '15px', textAlign: 'center' }}>📲 Notify Party</th>
                </tr>
              </thead>
              <tbody>
                {loading ? <tr><td colSpan={15} style={{ padding: '20px', textAlign: 'center', color: '#38bdf8' }}>Loading Data...</td></tr> : filteredRegister.length === 0 ? <tr><td colSpan={15} style={{ padding: '20px', textAlign: 'center', color: '#64748b' }}>No Data Found.</td></tr> : 
                  filteredRegister.map((t) => (
                  <tr key={t.id} style={{ borderBottom: '1px solid #334155', color: '#cbd5e1', fontSize: '12px' }}>
                    <td style={{ padding: '12px 15px', fontWeight: 'bold', color: '#38bdf8' }}>{t.Trip_ID || t.trip_id}</td>
                    <td style={{ padding: '12px 15px', color: '#f59e0b', fontWeight: 'bold' }}>{t.Operating_Company || t.operating_company || 'PRASAD TRANSPORT'}</td>
                    <td style={{ padding: '12px 15px', fontWeight: 'bold', color: '#fff' }}>{t.Customer || t.customer_name || t.Registered_Assessee}</td>
                    <td style={{ padding: '12px 15px' }}>{t.Loading_Date || t.loading_date}</td>
                    <td style={{ padding: '12px 15px', fontWeight: 'bold', color: '#fff' }}>{t.Challan_No || t.challan_no || '-'}</td>
                    <td style={{ padding: '12px 15px' }}>{t.Loading_Point || t.loading_point}</td>
                    <td style={{ padding: '12px 15px', color: '#38bdf8', fontWeight: 'bold' }}>{t.Vehical_No || t.vehicle_no || t.vehical_no}</td>
                    <td style={{ padding: '12px 15px' }}>{t.Consignee_Name || t.consignee_name}</td>
                    <td style={{ padding: '12px 15px' }}>{t.Product_Type || t.product_type}</td>
                    <td style={{ padding: '12px 15px', color: '#10b981', fontWeight: '900' }}>{t.Loaded_Qty || t.loaded_qty || t.driver_loaded_qty}</td>
                    <td style={{ padding: '12px 15px' }}>{t.Driver_Name || t.driver_name}</td>
                    
                    <td style={{ padding: '12px 15px', textAlign: 'center' }}>
                      <button onClick={() => handleEditTrip(t)} style={{ background: 'rgba(56, 189, 248, 0.2)', border: '1px solid #38bdf8', color: '#38bdf8', padding: '6px 12px', borderRadius: '20px', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold' }}>✏️ Edit</button>
                    </td>

                    <td style={{ padding: '12px 15px', textAlign: 'center' }}>
                      <button onClick={() => handleDeleteTrip(t.id)} style={{ background: 'rgba(239, 68, 68, 0.2)', border: '1px solid #ef4444', color: '#ef4444', padding: '6px 12px', borderRadius: '20px', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold' }}>🗑️ Delete</button>
                    </td>

                    <td style={{ padding: '12px 15px', textAlign: 'center' }}>
                      <button onClick={() => generateAndSavePDF(t)} style={{ background: 'rgba(16, 185, 129, 0.2)', border: '1px solid #10b981', color: '#10b981', padding: '6px 12px', borderRadius: '20px', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold' }}>🖨️ Multi-Copy LR</button>
                    </td>

                    <td style={{ padding: '12px 15px', textAlign: 'center' }}>
                      <button onClick={() => sendCustomerWhatsApp(t)} style={{ background: 'rgba(245, 158, 11, 0.2)', border: '1px solid #f59e0b', color: '#f59e0b', padding: '6px 12px', borderRadius: '20px', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold' }}>✉️ Party</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}