// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { collection, query, where, getDocs, updateDoc, doc } from 'firebase/firestore';
import { db } from './firebase';

interface DriverPortalProps {
  onBack?: () => void;
}

export default function DriverPortal({ onBack }: DriverPortalProps) {
  const [mobileNo, setMobileNo] = useState('');
  const [driver, setDriver] = useState<any>(null);
  const [activeTrips, setActiveTrips] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('TRIPS');

  // 🔐 1. HIGH-SECURITY DRIVER LOGIN (DEVICE BINDING)
  const handleLogin = async () => {
    if (!mobileNo) return alert("Please enter mobile number!");
    setLoading(true);
    try {
      const q = query(collection(db, "DRIVERS"), where("mobile", "==", mobileNo));
      const querySnapshot = await getDocs(q);
      
      if (!querySnapshot.empty) {
        const driverDoc = querySnapshot.docs[0];
        let driverData = { id: driverDoc.id, ...driverDoc.data() };

        // 🛡️ DEVICE BINDING SECURITY LOGIC
        const localDeviceId = localStorage.getItem('prasad_driver_device');

        if (!driverData.device_id) {
          const newDeviceId = 'DEV-' + Math.random().toString(36).substr(2, 9) + Date.now();
          localStorage.setItem('prasad_driver_device', newDeviceId);
          await updateDoc(doc(db, "DRIVERS", driverDoc.id), { device_id: newDeviceId });
          driverData.device_id = newDeviceId;
          alert("🔒 Device Locked! Your account is now secured to this mobile phone.");
        } else {
          if (localDeviceId !== driverData.device_id) {
            alert("🚨 SECURITY ALERT: Unauthorized Device!\nThis mobile number is already registered on another phone. If you changed your phone, contact Prasad Transport Admin.");
            setLoading(false);
            return; 
          }
        }

        setDriver(driverData);
        fetchDriverTrips(driverData.mobile, driverData.name);
      } else {
        alert("❌ Driver not found! Please check the mobile number.");
      }
    } catch (error) {
      console.error("Login Error:", error);
    }
    setLoading(false);
  };

  const fetchDriverTrips = async (driverMobile: string, driverName: string) => {
    try {
      const tSnap = await getDocs(collection(db, "TRIPS"));
      const trips = tSnap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter((t: any) => (t.driver_mobil_no === driverMobile || t.driver_name === driverName) && t.trip_status !== 'COMPLETED');
      setActiveTrips(trips);
    } catch (e) {
      console.error(e);
    }
  };

  const handleTripImageUpload = (e: any, tripId: string, fieldType: string) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        updateTripData(tripId, fieldType, reader.result);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleDriverDocumentUpload = (e: any, fieldType: string) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        updateDriverKYC(fieldType, reader.result);
      };
      reader.readAsDataURL(file);
    }
  };

  const updateTripData = async (tripId: string, fieldName: string, value: any) => {
    try {
      await updateDoc(doc(db, "TRIPS", tripId), { [fieldName]: value });
      alert("✅ Saved Successfully!");
      fetchDriverTrips(driver.mobile, driver.name); 
    } catch (e) {
      alert("Error saving data!");
    }
  };

  const updateDriverKYC = async (fieldName: string, value: any) => {
    try {
      await updateDoc(doc(db, "DRIVERS", driver.id), { [fieldName]: value });
      setDriver({ ...driver, [fieldName]: value });
      alert("✅ Details Saved Successfully!");
    } catch (e) {
      alert("Error updating details!");
    }
  };

  // --- LOGIN SCREEN ---
  if (!driver) {
    return (
      <div style={{ minHeight: '100vh', background: '#020617', display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '20px', position: 'relative' }}>
        
        {/* ⬅️ BACK BUTTON TO MAIN WEBSITE */}
        {onBack && (
          <button 
            onClick={onBack} 
            style={{ position: 'absolute', top: '30px', left: '30px', background: 'rgba(255,255,255,0.05)', color: '#94a3b8', border: '1px solid rgba(255,255,255,0.1)', padding: '10px 20px', borderRadius: '30px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '14px', fontWeight: 'bold', backdropFilter: 'blur(10px)', transition: '0.3s' }}
            onMouseOver={(e) => { e.currentTarget.style.color = '#fff'; e.currentTarget.style.background = 'rgba(255,255,255,0.1)'; }}
            onMouseOut={(e) => { e.currentTarget.style.color = '#94a3b8'; e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; }}
          >
            <span>⬅️</span> Back to Main Website
          </button>
        )}

        <div style={{ background: 'rgba(30, 41, 59, 0.8)', padding: '40px 30px', borderRadius: '20px', width: '100%', maxWidth: '400px', textAlign: 'center', border: '1px solid #38bdf8', boxShadow: '0 10px 30px rgba(56,189,248,0.2)' }}>
          <div style={{ fontSize: '60px', lineHeight: '1', marginBottom: '15px' }}>🚚</div>
          <h1 style={{ color: '#38bdf8', margin: '0 0 10px 0', fontSize: '32px', lineHeight: '1.2' }}>Driver App</h1>
          <p style={{ color: '#94a3b8', margin: '0 0 30px 0', fontSize: '14px', lineHeight: '1.4' }}>Secure Login for Prasad Transport</p>
          
          <input 
            type="tel" 
            placeholder="Enter Mobile Number" 
            value={mobileNo} 
            onChange={e => setMobileNo(e.target.value)}
            style={{ width: '100%', padding: '15px', borderRadius: '10px', border: '1px solid #475569', background: '#0f172a', color: '#fff', fontSize: '18px', textAlign: 'center', marginBottom: '20px', boxSizing: 'border-box' }}
          />
          <button 
            onClick={handleLogin}
            style={{ width: '100%', padding: '15px', background: 'linear-gradient(135deg, #38bdf8, #3b82f6)', color: '#0f172a', border: 'none', borderRadius: '10px', fontSize: '18px', fontWeight: '900', cursor: 'pointer', boxShadow: '0 5px 15px rgba(56,189,248,0.4)' }}
          >
            {loading ? 'Verifying...' : 'SECURE LOGIN 🚀'}
          </button>
          <div style={{ color: '#10b981', fontSize: '11px', marginTop: '20px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px', fontWeight: 'bold' }}>
            <span>🔒</span> Device Fingerprint Protected
          </div>
        </div>
      </div>
    );
  }

  // --- MAIN APP SCREEN ---
  return (
    <div style={{ minHeight: '100vh', background: '#0f172a', paddingBottom: '80px', fontFamily: 'sans-serif' }}>
      
      {/* SMART APP HEADER WITH DRIVER PHOTO */}
      <div style={{ background: '#020617', padding: '15px 20px', borderBottom: '1px solid #334155', display: 'flex', justifyContent: 'space-between', alignItems: 'center', position: 'sticky', top: 0, zIndex: 100, boxShadow: '0 4px 15px rgba(0,0,0,0.5)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
          <div style={{ position: 'relative' }}>
            <img 
              src={driver.profile_photo || 'https://cdn-icons-png.flaticon.com/512/3135/3135715.png'} 
              alt="Profile" 
              style={{ width: '50px', height: '50px', borderRadius: '50%', objectFit: 'cover', border: '2px solid #38bdf8', background: '#1e293b' }} 
            />
            {driver.office_kyc_approved && <span style={{ position: 'absolute', bottom: -5, right: -5, background: '#10b981', borderRadius: '50%', padding: '2px', fontSize: '10px' }}>✅</span>}
          </div>
          <div>
            <h2 style={{ color: '#fff', margin: 0, fontSize: '18px' }}>👋 {driver.name}</h2>
            <p style={{ color: '#10b981', margin: '2px 0 0 0', fontSize: '12px', fontWeight: 'bold' }}>🚚 Vehicle: {driver.assigned_vehicle || 'Not Assigned'}</p>
          </div>
        </div>
        <div style={{display: 'flex', gap: '10px'}}>
           <button onClick={() => setDriver(null)} style={{ background: 'rgba(239, 68, 68, 0.1)', border: '1px solid #ef4444', color: '#ef4444', padding: '5px 10px', borderRadius: '5px', fontSize: '12px', fontWeight: 'bold' }}>Logout</button>
        </div>
      </div>

      <div style={{ padding: '15px' }}>
        {/* Module Switcher */}
        <div style={{ display: 'flex', gap: '10px', marginBottom: '20px' }}>
          <button onClick={() => setActiveTab('TRIPS')} style={{ flex: 1, padding: '12px', background: activeTab === 'TRIPS' ? '#38bdf8' : '#334155', color: activeTab === 'TRIPS' ? '#0f172a' : '#cbd5e1', border: 'none', borderRadius: '10px', fontWeight: 'bold', transition: '0.3s' }}>🚚 My Trips</button>
          <button onClick={() => setActiveTab('KYC')} style={{ flex: 1, padding: '12px', background: activeTab === 'KYC' ? '#c084fc' : '#334155', color: activeTab === 'KYC' ? '#0f172a' : '#cbd5e1', border: 'none', borderRadius: '10px', fontWeight: 'bold', transition: '0.3s' }}>👤 Profile & Docs</button>
        </div>

        {/* 🚚 TAB: MY TRIPS */}
        {activeTab === 'TRIPS' && (
          <div>
            {activeTrips.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '50px 20px', color: '#94a3b8', background: '#1e293b', borderRadius: '15px', border: '1px dashed #334155' }}>
                <div style={{ fontSize: '40px', marginBottom: '10px' }}>😴</div>
                No Active Trips Currently Assigned.
              </div>
            ) : (
              activeTrips.map((trip: any) => (
                <div key={trip.id} style={{ background: '#1e293b', padding: '20px', borderRadius: '15px', marginBottom: '20px', borderLeft: '4px solid #38bdf8' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '10px' }}>
                    <span style={{ color: '#38bdf8', fontSize: '12px', fontWeight: 'bold' }}>{trip.trip_id}</span>
                    <span style={{ background: '#334155', color: '#cbd5e1', padding: '3px 8px', borderRadius: '5px', fontSize: '10px' }}>{trip.trip_status}</span>
                  </div>
                  
                  <h3 style={{ color: '#fff', margin: '0 0 15px 0' }}>{trip.loading_point} ➔ {trip.consignee_name}</h3>

                  {/* LOADING SECTION */}
                  <div style={{ background: '#0f172a', padding: '15px', borderRadius: '10px', marginBottom: '15px' }}>
                    <h4 style={{ color: '#f59e0b', margin: '0 0 10px 0', display: 'flex', justifyContent: 'space-between' }}>
                      <span>1. Loading Details</span>
                      {trip.office_approved_loading && <span style={{ color: '#10b981', fontSize: '12px' }}>✅ Approved</span>}
                    </h4>
                    
                    <label style={{ color: '#94a3b8', fontSize: '12px' }}>Enter Loaded Qty (Ltr)</label>
                    <input type="number" defaultValue={trip.driver_loaded_qty || ''} onBlur={(e) => updateTripData(trip.id, 'driver_loaded_qty', e.target.value)} disabled={trip.office_approved_loading} style={{ width: '100%', padding: '10px', marginBottom: '10px', background: trip.office_approved_loading ? '#334155' : '#1e293b', border: '1px solid #475569', color: '#fff', borderRadius: '5px', boxSizing: 'border-box' }} />

                    <label style={{ color: '#94a3b8', fontSize: '12px' }}>Upload Loading Challan Photo</label>
                    {trip.driver_loading_photo ? (
                      <div style={{ position: 'relative' }}>
                        <img src={trip.driver_loading_photo} alt="Challan" style={{ width: '100%', height: '150px', objectFit: 'cover', borderRadius: '8px', opacity: trip.office_approved_loading ? 0.7 : 1 }} />
                        {!trip.office_approved_loading && <button onClick={() => updateTripData(trip.id, 'driver_loading_photo', null)} style={{ position: 'absolute', top: 5, right: 5, background: 'rgba(239,68,68,0.9)', color: 'white', border: 'none', borderRadius: '5px', padding: '5px 10px', fontWeight: 'bold' }}>✕ Retake</button>}
                      </div>
                    ) : (
                      <input type="file" accept="image/*" capture="environment" onChange={(e) => handleTripImageUpload(e, trip.id, 'driver_loading_photo')} disabled={trip.office_approved_loading} style={{ width: '100%', padding: '10px', background: '#1e293b', color: '#38bdf8', borderRadius: '5px', border: '1px dashed #38bdf8', boxSizing: 'border-box' }} />
                    )}
                  </div>

                  {/* UNLOADING SECTION */}
                  <div style={{ background: '#0f172a', padding: '15px', borderRadius: '10px' }}>
                    <h4 style={{ color: '#10b981', margin: '0 0 10px 0', display: 'flex', justifyContent: 'space-between' }}>
                      <span>2. Unloading Details</span>
                      {trip.office_approved_unloading && <span style={{ color: '#10b981', fontSize: '12px' }}>✅ Approved</span>}
                    </h4>

                    <label style={{ color: '#94a3b8', fontSize: '12px' }}>Enter Unloaded Qty (Ltr)</label>
                    <input type="number" defaultValue={trip.driver_unloaded_qty || ''} onBlur={(e) => updateTripData(trip.id, 'driver_unloaded_qty', e.target.value)} disabled={trip.office_approved_unloading} style={{ width: '100%', padding: '10px', marginBottom: '10px', background: trip.office_approved_unloading ? '#334155' : '#1e293b', border: '1px solid #475569', color: '#fff', borderRadius: '5px', boxSizing: 'border-box' }} />

                    <label style={{ color: '#94a3b8', fontSize: '12px' }}>Upload Unloading Receipt / Dip</label>
                    {trip.driver_unloading_photo ? (
                      <div style={{ position: 'relative' }}>
                        <img src={trip.driver_unloading_photo} alt="Receipt" style={{ width: '100%', height: '150px', objectFit: 'cover', borderRadius: '8px', opacity: trip.office_approved_unloading ? 0.7 : 1 }} />
                        {!trip.office_approved_unloading && <button onClick={() => updateTripData(trip.id, 'driver_unloading_photo', null)} style={{ position: 'absolute', top: 5, right: 5, background: 'rgba(239,68,68,0.9)', color: 'white', border: 'none', borderRadius: '5px', padding: '5px 10px', fontWeight: 'bold' }}>✕ Retake</button>}
                      </div>
                    ) : (
                      <input type="file" accept="image/*" capture="environment" onChange={(e) => handleTripImageUpload(e, trip.id, 'driver_unloading_photo')} disabled={trip.office_approved_unloading} style={{ width: '100%', padding: '10px', background: '#1e293b', color: '#10b981', borderRadius: '5px', border: '1px dashed #10b981', boxSizing: 'border-box' }} />
                    )}
                  </div>

                </div>
              ))
            )}
          </div>
        )}

        {/* 👤 TAB: MY PROFILE & DOCS */}
        {activeTab === 'KYC' && (
          <div style={{ background: '#1e293b', padding: '20px', borderRadius: '15px' }}>
             <h3 style={{ color: '#fff', margin: '0 0 15px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
               <span>Profile & Documents</span>
               {driver.office_kyc_approved && <span style={{ color: '#10b981', fontSize: '10px', background: 'rgba(16,185,129,0.1)', padding: '5px 8px', borderRadius: '5px', border: '1px solid #10b981' }}>✅ VERIFIED</span>}
             </h3>

             {driver.office_kyc_approved && (
               <div style={{ padding: '10px', background: 'rgba(245,158,11,0.1)', color: '#f59e0b', fontSize: '12px', borderRadius: '8px', marginBottom: '20px', border: '1px solid rgba(245,158,11,0.3)' }}>
                 ⚠️ Your account is fully verified. Contact Office Admin to make changes.
               </div>
             )}

             <div style={{ background: '#0f172a', padding: '20px', borderRadius: '10px', marginBottom: '15px', textAlign: 'center', border: '1px dashed #c084fc' }}>
                <label style={{ color: '#c084fc', fontSize: '14px', fontWeight: 'bold', display: 'block', marginBottom: '10px' }}>📸 My Profile Photo (Selfie)</label>
                {driver.profile_photo ? (
                  <div style={{ position: 'relative', display: 'inline-block' }}>
                    <img src={driver.profile_photo} alt="Profile" style={{ width: '120px', height: '120px', objectFit: 'cover', borderRadius: '50%', border: '4px solid #c084fc', boxShadow: '0 0 15px rgba(192, 132, 252, 0.4)' }} />
                    {!driver.office_kyc_approved && <button onClick={() => updateDriverKYC('profile_photo', null)} style={{ position: 'absolute', top: 0, right: -10, background: '#ef4444', color: 'white', border: 'none', borderRadius: '50%', width: '30px', height: '30px', cursor: 'pointer', fontWeight: 'bold' }}>✕</button>}
                  </div>
                ) : (
                  <input type="file" accept="image/*" capture="user" onChange={(e) => handleDriverDocumentUpload(e, 'profile_photo')} disabled={driver.office_kyc_approved} style={{ width: '100%', padding: '10px', background: '#1e293b', color: '#c084fc', borderRadius: '5px', boxSizing: 'border-box' }} />
                )}
             </div>

             <div style={{ background: '#0f172a', padding: '15px', borderRadius: '10px', marginBottom: '15px' }}>
                <label style={{ color: '#38bdf8', fontSize: '14px', fontWeight: 'bold', display: 'block', marginBottom: '10px' }}>🪪 Driving License (DL) Photo</label>
                {driver.dl_photo ? (
                  <div style={{ position: 'relative' }}>
                    <img src={driver.dl_photo} alt="Driving License" style={{ width: '100%', height: '150px', objectFit: 'cover', borderRadius: '8px', opacity: driver.office_kyc_approved ? 0.6 : 1 }} />
                    {!driver.office_kyc_approved && <button onClick={() => updateDriverKYC('dl_photo', null)} style={{ position: 'absolute', top: 5, right: 5, background: 'rgba(239,68,68,0.9)', color: 'white', border: 'none', borderRadius: '5px', padding: '5px 10px' }}>✕ Retake</button>}
                  </div>
                ) : (
                  <input type="file" accept="image/*" capture="environment" onChange={(e) => handleDriverDocumentUpload(e, 'dl_photo')} disabled={driver.office_kyc_approved} style={{ width: '100%', padding: '10px', background: '#1e293b', color: '#fff', borderRadius: '5px', boxSizing: 'border-box' }} />
                )}
             </div>

             <div style={{ background: '#0f172a', padding: '15px', borderRadius: '10px', marginBottom: '15px' }}>
                <label style={{ color: '#10b981', fontSize: '14px', fontWeight: 'bold', display: 'block', marginBottom: '10px' }}>🏦 Bank Passbook / Cheque Photo</label>
                {driver.bank_passbook_photo ? (
                  <div style={{ position: 'relative' }}>
                    <img src={driver.bank_passbook_photo} alt="Bank Passbook" style={{ width: '100%', height: '150px', objectFit: 'cover', borderRadius: '8px', opacity: driver.office_kyc_approved ? 0.6 : 1 }} />
                    {!driver.office_kyc_approved && <button onClick={() => updateDriverKYC('bank_passbook_photo', null)} style={{ position: 'absolute', top: 5, right: 5, background: 'rgba(239,68,68,0.9)', color: 'white', border: 'none', borderRadius: '5px', padding: '5px 10px' }}>✕ Retake</button>}
                  </div>
                ) : (
                  <input type="file" accept="image/*" capture="environment" onChange={(e) => handleDriverDocumentUpload(e, 'bank_passbook_photo')} disabled={driver.office_kyc_approved} style={{ width: '100%', padding: '10px', background: '#1e293b', color: '#fff', borderRadius: '5px', boxSizing: 'border-box' }} />
                )}
             </div>

             <div style={{ background: '#0f172a', padding: '15px', borderRadius: '10px', marginBottom: '15px' }}>
                <label style={{ color: '#f59e0b', fontSize: '14px', fontWeight: 'bold', display: 'block', marginBottom: '10px' }}>📄 Aadhar Card Photo</label>
                {driver.aadhar_photo ? (
                  <div style={{ position: 'relative' }}>
                    <img src={driver.aadhar_photo} alt="Aadhar Card" style={{ width: '100%', height: '150px', objectFit: 'cover', borderRadius: '8px', opacity: driver.office_kyc_approved ? 0.6 : 1 }} />
                    {!driver.office_kyc_approved && <button onClick={() => updateDriverKYC('aadhar_photo', null)} style={{ position: 'absolute', top: 5, right: 5, background: 'rgba(239,68,68,0.9)', color: 'white', border: 'none', borderRadius: '5px', padding: '5px 10px' }}>✕ Retake</button>}
                  </div>
                ) : (
                  <input type="file" accept="image/*" capture="environment" onChange={(e) => handleDriverDocumentUpload(e, 'aadhar_photo')} disabled={driver.office_kyc_approved} style={{ width: '100%', padding: '10px', background: '#1e293b', color: '#fff', borderRadius: '5px', boxSizing: 'border-box' }} />
                )}
             </div>

             <div style={{ marginTop: '20px', borderTop: '1px dashed #334155', paddingTop: '15px' }}>
               <label style={{ color: '#94a3b8', fontSize: '12px' }}>Aadhar Number</label>
               <input type="text" defaultValue={driver.aadhar_no || ''} onBlur={(e) => updateDriverKYC('aadhar_no', e.target.value)} disabled={driver.office_kyc_approved} style={{ width: '100%', padding: '12px', marginBottom: '15px', background: driver.office_kyc_approved ? '#334155' : '#0f172a', border: '1px solid #475569', color: '#fff', borderRadius: '5px', boxSizing: 'border-box' }} />

               <label style={{ color: '#94a3b8', fontSize: '12px' }}>Bank Account Number</label>
               <input type="text" defaultValue={driver.account_no || ''} onBlur={(e) => updateDriverKYC('account_no', e.target.value)} disabled={driver.office_kyc_approved} style={{ width: '100%', padding: '12px', marginBottom: '15px', background: driver.office_kyc_approved ? '#334155' : '#0f172a', border: '1px solid #475569', color: '#fff', borderRadius: '5px', boxSizing: 'border-box' }} />

               <label style={{ color: '#94a3b8', fontSize: '12px' }}>Bank IFSC Code</label>
               <input type="text" defaultValue={driver.ifsc_code || ''} onBlur={(e) => updateDriverKYC('ifsc_code', e.target.value)} disabled={driver.office_kyc_approved} style={{ width: '100%', padding: '12px', marginBottom: '15px', background: driver.office_kyc_approved ? '#334155' : '#0f172a', border: '1px solid #475569', color: '#fff', borderRadius: '5px', boxSizing: 'border-box' }} />
             </div>
          </div>
        )}

      </div>
    </div>
  );
}