import React, { useState, useEffect } from 'react';
import { doc, getDoc } from 'firebase/firestore';
import { db } from './firebase'; // 👈 FIREBASE IMPORT

export default function PublicWebsite({ onLoginClick }: { onLoginClick?: () => void }) {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [currentSlide, setCurrentSlide] = useState(0);

  // 🌟 DEFAULT SITE DATA (ताकि डेटा लोड होने तक स्क्रीन खाली न रहे)
  const [siteData, setSiteData] = useState({
    heroBadge: "India's #1 B2B Transport Ecosystem",
    title1: 'A New Era of',
    title2: 'Logistics & Trust.',
    desc: 'Welcome to Prasad Transport ERP. Experience the power of Live Bidding, 100% Secure Escrow Payments, and AI-Verified Fleets.',
    bgImages: [
      "https://images.unsplash.com/photo-1519003722824-194d4455a60c?q=80&w=2000&auto=format&fit=crop",
      "https://images.unsplash.com/photo-1586528116311-ad8ed7c1590f?q=80&w=2000&auto=format&fit=crop",
      "https://images.unsplash.com/photo-1601584115197-04ecc0da31d7?q=80&w=2000&auto=format&fit=crop",
      "https://images.unsplash.com/photo-1511447333015-45b65e60f6d5?q=80&w=2000&auto=format&fit=crop"
    ],
    aboutBadge: 'Our Heritage & Mission',
    aboutTitle: 'Legacy of Trust. Future of Logistics.',
    aboutDesc1: "For years, Prasad Transport has been the undisputed backbone of logistics in the region. We have proudly partnered with industry giants like IOCL, BPCL, and HPCL, handling highly critical and secured Oil and Gas Tanker operations with 100% safety and zero errors.",
    aboutVisionTitle: 'Our Super-App Vision',
    aboutVisionDesc: 'We are transforming traditional transport into a 100% transparent, AI-driven ecosystem. Eliminating middlemen ensures customers get the best rates via live bidding, while Fleet Partners get direct business, instant advances, and VIP respect. No confusing calls—just smart logistics.',
    fleetBadge: 'Unmatched Capacity',
    fleetTitle: 'Vehicles We Operate',
    fleetDesc: 'From highly volatile Oil & Gas to heavy industrial cargo, our AI-dispatched network covers every need.',
    contactBadge: '24/7 Priority Support',
    contactTitle: 'Get In Touch',
    email1: 'info@prasadtransport.com',
    email2: 'support@prasadtransport.com',
    address: 'Bongaigaon, Assam, India',
    waNumber: '919999999999',
    waMessage: 'Hello Prasad Transport, I want to join your network.',
    footerText: '© 2026 PRASAD TRANSPORT ERP. SECURED BY MAMTA AI.'
  });

  // 🚀 FETCH DATA FROM FIREBASE (यहाँ से वेबसाइट लाइव हो जाएगी)
  useEffect(() => {
    const fetchSiteSettings = async () => {
      try {
        const docRef = doc(db, "WEBSITE", "SETTINGS");
        const docSnap = await getDoc(docRef);
        if (docSnap.exists()) {
          const fetchedData = docSnap.data();
          // Merge old default with new fetched data
          setSiteData(prevData => ({ ...prevData, ...fetchedData })); 
        }
      } catch (error) {
        console.error("Error fetching website settings from Firebase:", error);
      }
    };
    fetchSiteSettings();
  }, []);

  // ⏱️ Auto-Slide Timer (Changes every 5 seconds)
  useEffect(() => {
    if (siteData.bgImages.length <= 1) return;
    const interval = setInterval(() => {
      setCurrentSlide((prev) => (prev + 1) % siteData.bgImages.length);
    }, 5000);
    return () => clearInterval(interval);
  }, [siteData.bgImages.length]);

  // 📱 DYNAMIC WHATSAPP LINK
  const openWhatsApp = () => {
    const url = `https://wa.me/${siteData.waNumber}?text=${encodeURIComponent(siteData.waMessage)}`;
    window.open(url, '_blank');
  };

  return (
    <div className="min-h-screen bg-slate-50 font-sans text-gray-800 overflow-x-hidden scroll-smooth relative selection:bg-orange-500 selection:text-white">
      
      {/* 🚀 1. TOP NAVIGATION BAR */}
      <nav className="fixed top-0 w-full bg-white/95 backdrop-blur-md shadow-sm border-b border-gray-100 z-50 transition-all duration-300">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-20">
            
            {/* 🌟 LOGO */}
            <div className="flex items-center gap-3 cursor-pointer group" onClick={() => window.scrollTo(0, 0)}>
              <div className="relative flex items-center justify-center w-12 h-12 bg-gradient-to-br from-blue-950 to-blue-900 rounded-xl shadow-[0_8px_20px_rgba(23,37,84,0.3)] border border-blue-800 overflow-hidden transform group-hover:scale-105 transition-all duration-300">
                <div className="absolute inset-0 bg-white/5 opacity-50 bg-[radial-gradient(#fff_1px,transparent_1px)] [background-size:4px_4px]"></div>
                <svg className="w-7 h-7 text-orange-500 relative z-10 drop-shadow-[0_0_8px_rgba(249,115,22,0.8)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
                  <polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline>
                  <line x1="12" y1="22.08" x2="12" y2="12"></line>
                </svg>
              </div>
              <div className="flex flex-col ml-1 mt-1">
                <h1 className="text-[32px] font-black tracking-tighter text-blue-950 m-0 leading-none flex items-baseline">
                  PRASAD<span className="text-orange-500 text-4xl leading-none ml-0.5 animate-pulse">.</span>
                </h1>
                <h2 className="text-[10px] font-black text-slate-500 tracking-[0.3em] m-0 leading-none mt-1.5 uppercase">
                  Transport ERP
                </h2>
              </div>
            </div>

            {/* Desktop Menu */}
            <div className="hidden md:flex items-center space-x-8 font-bold text-sm text-slate-600">
              <a href="#about" className="hover:text-orange-500 transition-colors">Our Mission</a>
              <a href="#how-it-works" className="hover:text-orange-500 transition-colors">How It Works</a>
              <a href="#fleet" className="hover:text-orange-500 transition-colors">Our Fleet</a>
              <a href="#contact" className="hover:text-orange-500 transition-colors">Contact</a>
              
              <button onClick={onLoginClick} className="bg-blue-950 hover:bg-blue-900 text-white px-7 py-2.5 rounded-full shadow-lg shadow-blue-900/20 transition transform hover:-translate-y-0.5 border border-blue-800 flex items-center gap-2 ml-2">
                <span className="text-orange-500">🔒</span> Sign In ERP
              </button>
            </div>

            {/* Mobile Menu Button */}
            <div className="md:hidden flex items-center">
              <button onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)} className="text-blue-950 hover:text-orange-500 focus:outline-none">
                <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 6h16M4 12h16m-7 6h7"></path></svg>
              </button>
            </div>
          </div>
        </div>

        {/* Mobile Dropdown Menu */}
        {isMobileMenuOpen && (
          <div className="md:hidden bg-white border-t border-gray-100 px-4 py-4 space-y-4 shadow-2xl absolute w-full left-0">
            <a href="#about" className="block text-gray-800 font-bold px-2 py-1" onClick={() => setIsMobileMenuOpen(false)}>Our Mission</a>
            <a href="#how-it-works" className="block text-gray-800 font-bold px-2 py-1" onClick={() => setIsMobileMenuOpen(false)}>How It Works</a>
            <a href="#fleet" className="block text-gray-800 font-bold px-2 py-1" onClick={() => setIsMobileMenuOpen(false)}>Our Fleet</a>
            <a href="#contact" className="block text-gray-800 font-bold px-2 py-1" onClick={() => setIsMobileMenuOpen(false)}>Contact Us</a>
            <button onClick={onLoginClick} className="w-full bg-blue-950 text-white font-bold py-3 rounded-xl mt-2 shadow-md flex justify-center items-center gap-2">
              <span className="text-orange-500">🔒</span> Sign In ERP →
            </button>
          </div>
        )}
      </nav>

      {/* 🌟 2. HERO SECTION WITH DYNAMIC SLIDING BACKGROUND */}
      <div className="relative pt-20 pb-16 md:pt-32 md:pb-24 flex items-center min-h-[100vh] bg-[#020617] overflow-hidden">
        <div className="absolute inset-0 z-0">
          {siteData.bgImages.map((img, index) => (
            <div 
              key={index}
              className={`absolute inset-0 transition-all duration-1500 ease-in-out ${currentSlide === index ? 'opacity-100 scale-105' : 'opacity-0 scale-100'}`}
              style={{ backgroundImage: `url(${img})`, backgroundSize: 'cover', backgroundPosition: 'center' }}
            ></div>
          ))}
          <div className="absolute inset-0 bg-gradient-to-r from-[#020617]/95 via-[#020617]/80 to-transparent"></div>
        </div>

        <div className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 w-full">
          <div className="max-w-3xl">
            <span className="inline-block py-1.5 px-4 rounded-full bg-orange-500/20 border border-orange-500/50 text-orange-400 text-xs font-bold tracking-widest uppercase mb-6 backdrop-blur-sm">
              {siteData.heroBadge}
            </span>
            <h1 className="text-5xl md:text-7xl lg:text-8xl font-black text-white leading-[1.1] mb-6 tracking-tight drop-shadow-2xl">
              {siteData.title1} <br/>
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-orange-400 to-yellow-300 drop-shadow-md">{siteData.title2}</span>
            </h1>
            <p className="text-lg md:text-xl text-slate-300 mb-10 max-w-xl leading-relaxed font-medium drop-shadow-md">
              {siteData.desc}
            </p>
            <div className="flex flex-col sm:flex-row gap-4">
              <button onClick={onLoginClick} className="group relative bg-orange-500 hover:bg-orange-600 text-white font-black text-lg py-4 px-8 rounded-xl shadow-[0_0_30px_rgba(249,115,22,0.4)] transition-all overflow-hidden flex items-center justify-center gap-3">
                <div className="absolute inset-0 w-full h-full bg-gradient-to-r from-transparent via-white/20 to-transparent -translate-x-full group-hover:animate-[shimmer_1.5s_infinite]"></div>
                <span className="text-2xl drop-shadow-md">🏢</span> <span className="relative tracking-wide">Join as Customer</span>
              </button>
              <button onClick={onLoginClick} className="bg-slate-800/50 hover:bg-slate-800 backdrop-blur-md border border-slate-600 hover:border-slate-400 text-white font-bold text-lg py-4 px-8 rounded-xl transition-all shadow-xl flex items-center justify-center gap-3">
                <span className="text-2xl drop-shadow-md">🚛</span> <span className="tracking-wide">Join as Partner</span>
              </button>
            </div>
            
            {/* Dynamic Slider Dots */}
            <div className="flex gap-2 mt-12">
              {siteData.bgImages.map((_, i) => (
                <div key={i} className={`h-1.5 rounded-full transition-all duration-500 ${currentSlide === i ? 'w-10 bg-orange-500 shadow-[0_0_10px_#f97316]' : 'w-3 bg-slate-600'}`}></div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* 🏢 3. ABOUT US & MISSION (DYNAMIC) */}
      <div id="about" className="py-24 bg-white relative overflow-hidden border-b border-gray-100">
        <div className="absolute top-0 right-0 -mt-20 -mr-20 w-[500px] h-[500px] bg-orange-50 rounded-full blur-[100px] opacity-60 pointer-events-none"></div>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 items-center">
            <div className="relative group">
              <div className="rounded-[40px] overflow-hidden shadow-2xl border-4 border-white transform transition-transform duration-700 group-hover:scale-[1.02]">
                <img src={siteData.bgImages[0]} alt="Prasad Transport Fleet" className="w-full h-[500px] object-cover" />
              </div>
              <div className="absolute -bottom-8 -right-8 bg-blue-950 p-8 rounded-3xl shadow-2xl hidden md:block border-4 border-white transform group-hover:-translate-y-4 transition-transform duration-500">
                <p className="text-5xl font-black text-orange-500 mb-1">2026</p>
                <p className="text-white text-xs font-bold tracking-widest uppercase">Tech Leader</p>
              </div>
            </div>
            <div>
              <span className="inline-block py-1.5 px-4 rounded-full bg-blue-50 text-blue-700 text-xs font-bold tracking-widest uppercase mb-6 border border-blue-100">
                {siteData.aboutBadge}
              </span>
              <h2 className="text-4xl md:text-5xl font-black text-blue-950 leading-tight mb-6 tracking-tight">
                {siteData.aboutTitle.split('.')[0]}.<br/><span className="text-orange-500">{siteData.aboutTitle.split('.')[1]}</span>
              </h2>
              <div className="space-y-6 text-slate-600 text-lg font-medium leading-relaxed">
                <p>{siteData.aboutDesc1}</p>
                <div className="bg-slate-50 p-8 rounded-3xl border-l-4 border-orange-500 shadow-sm hover:shadow-md transition-shadow">
                  <h4 className="font-black text-blue-950 mb-3 flex items-center gap-2 text-xl"><span>🚀</span> {siteData.aboutVisionTitle}</h4>
                  <p className="text-sm text-slate-600 leading-relaxed">{siteData.aboutVisionDesc}</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 💡 4. THE INVITATION: HOW IT WORKS */}
      <div id="how-it-works" className="py-24 bg-slate-50 border-t border-slate-200 relative">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-20">
            <span className="inline-block py-1.5 px-4 rounded-full bg-slate-200 text-slate-700 text-xs font-bold tracking-widest uppercase mb-4">
              Join India's Most Secure Network
            </span>
            <h2 className="text-4xl md:text-5xl font-black text-blue-950 tracking-tight mb-6">Choose Your Portal</h2>
            <p className="text-slate-500 max-w-3xl mx-auto text-lg leading-relaxed">
              We have built a 100% transparent B2B marketplace. Whether you need to move goods or you own the trucks to move them, Prasad Transport ERP gives you the ultimate control.
            </p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-10">
            
            {/* 🔥 CUSTOMER INVITATION */}
            <div className="bg-white rounded-[40px] p-8 md:p-12 border border-slate-200 relative overflow-hidden hover:shadow-2xl hover:-translate-y-2 transition-all duration-500 flex flex-col h-full">
              <div className="absolute top-0 right-0 w-64 h-64 bg-blue-50 rounded-full blur-[80px] -mr-20 -mt-20"></div>
              
              <div className="flex items-center gap-6 mb-8 relative z-10">
                <div className="w-20 h-20 bg-blue-600 rounded-[24px] flex items-center justify-center text-4xl shadow-xl shadow-blue-600/30 text-white">🏢</div>
                <div>
                  <h3 className="text-3xl font-black text-blue-950 leading-tight">Customer <br/><span className="text-blue-600 text-xl font-bold">Load Provider</span></h3>
                </div>
              </div>
              
              <div className="bg-blue-50 rounded-2xl p-6 mb-10 border border-blue-100 relative z-10">
                <p className="text-blue-900 font-bold italic">"The Boss Experience. 100% Security. Best Market Rates."</p>
              </div>

              <div className="space-y-8 relative z-10 flex-grow">
                <div className="flex gap-5">
                  <div className="w-10 h-10 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center font-black shrink-0">1</div>
                  <div>
                    <h4 className="text-lg font-black text-blue-950">Smart Registration (0% Fraud)</h4>
                    <p className="text-sm text-slate-600 mt-1.5 leading-relaxed">Only verified B2B businesses enter. Simply enter your GST Number, and our system verifies your company instantly.</p>
                  </div>
                </div>
                <div className="flex gap-5">
                  <div className="w-10 h-10 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center font-black shrink-0">2</div>
                  <div>
                    <h4 className="text-lg font-black text-blue-950">Live Bid Dashboard</h4>
                    <p className="text-sm text-slate-600 mt-1.5 leading-relaxed">Watch verified fleet owners bid against each other in real-time. A stock-market-like screen ensuring you get the lowest price.</p>
                  </div>
                </div>
                <div className="flex gap-5">
                  <div className="w-10 h-10 rounded-full bg-green-100 text-green-700 flex items-center justify-center font-black shrink-0">🔒</div>
                  <div>
                    <h4 className="text-lg font-black text-green-700">Payment Escrow System</h4>
                    <p className="text-sm text-slate-600 mt-1.5 leading-relaxed">Your money is safe. You deposit funds securely into Prasad's Escrow system. The truck owner is paid only when the deal is executed perfectly.</p>
                  </div>
                </div>
              </div>

              <div className="mt-10 pt-8 border-t border-slate-100 relative z-10">
                <button onClick={onLoginClick} className="w-full bg-blue-600 hover:bg-blue-700 text-white font-black py-4 rounded-2xl shadow-lg hover:shadow-xl transition-all text-lg flex justify-center items-center gap-2">
                  Enter Customer Portal ➔
                </button>
              </div>
            </div>

            {/* 🔥 VEHICLE OWNER INVITATION */}
            <div className="bg-blue-950 rounded-[40px] p-8 md:p-12 border border-blue-900 relative overflow-hidden hover:shadow-2xl hover:-translate-y-2 transition-all duration-500 flex flex-col h-full hover:border-orange-500">
              <div className="absolute top-0 right-0 w-64 h-64 bg-orange-500/10 rounded-full blur-[80px] -mr-20 -mt-20"></div>
              
              <div className="flex items-center gap-6 mb-8 relative z-10">
                <div className="w-20 h-20 bg-orange-500 rounded-[24px] flex items-center justify-center text-4xl shadow-xl shadow-orange-500/30 text-white">🚛</div>
                <div>
                  <h3 className="text-3xl font-black text-white leading-tight">Vehicle Owner <br/><span className="text-orange-400 text-xl font-bold">Fleet Partner</span></h3>
                </div>
              </div>

              <div className="bg-slate-900 rounded-2xl p-6 mb-10 border border-slate-800 relative z-10">
                <p className="text-orange-400 font-bold italic">"Your Digital Garage. Direct Loads. Maximum Profit."</p>
              </div>

              <div className="space-y-8 relative z-10 flex-grow">
                <div className="flex gap-5">
                  <div className="w-10 h-10 rounded-full bg-orange-500/20 text-orange-500 flex items-center justify-center font-black shrink-0">1</div>
                  <div>
                    <h4 className="text-lg font-black text-white">2-Second AI KYC</h4>
                    <p className="text-sm text-slate-400 mt-1.5 leading-relaxed">Upload your RC, DL, and PAN. Our powerful <strong className="text-white">Mamta AI</strong> verifies documents instantly giving you a <span className="bg-green-500/20 text-green-400 px-1.5 py-0.5 rounded font-bold">Verified ✅</span> badge.</p>
                  </div>
                </div>
                <div className="flex gap-5">
                  <div className="w-10 h-10 rounded-full bg-orange-500/20 text-orange-500 flex items-center justify-center font-black shrink-0">2</div>
                  <div>
                    <h4 className="text-lg font-black text-white">Live Load Board (Mobile-First)</h4>
                    <p className="text-sm text-slate-400 mt-1.5 leading-relaxed">A highly simple mobile interface. See only the loads that match your truck's capacity. No more calling brokers. Just tap and Bid.</p>
                  </div>
                </div>
                <div className="flex gap-5">
                  <div className="w-10 h-10 rounded-full bg-orange-500/20 text-orange-500 flex items-center justify-center font-black shrink-0">3</div>
                  <div>
                    <h4 className="text-lg font-black text-white">Direct Negotiation Room</h4>
                    <p className="text-sm text-slate-400 mt-1.5 leading-relaxed">Chat directly with the customer through our blind negotiation room to finalize the freight rate. A transparent micro-commission is applied upon booking.</p>
                  </div>
                </div>
              </div>

              <div className="mt-10 pt-8 border-t border-slate-800 relative z-10">
                <button onClick={onLoginClick} className="w-full bg-orange-500 hover:bg-orange-600 text-white font-black py-4 rounded-2xl shadow-[0_0_20px_rgba(249,115,22,0.3)] hover:shadow-[0_0_30px_rgba(249,115,22,0.5)] transition-all text-lg flex justify-center items-center gap-2">
                  Enter Partner Portal ➔
                </button>
              </div>
            </div>

          </div>
        </div>
      </div>

      {/* 🚛 5. OUR FLEET (DYNAMIC) */}
      <div id="fleet" className="py-24 bg-[#020617] relative overflow-hidden text-white border-t-4 border-orange-500">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
          <div className="text-center mb-20">
            <h2 className="text-sm font-bold text-orange-500 tracking-widest uppercase mb-2">{siteData.fleetBadge}</h2>
            <h3 className="text-4xl md:text-5xl font-black text-white tracking-tight">{siteData.fleetTitle}</h3>
            <p className="text-slate-400 mt-4 max-w-2xl mx-auto text-lg leading-relaxed">{siteData.fleetDesc}</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            <div className="bg-slate-900/40 backdrop-blur-md rounded-[32px] p-10 border border-slate-800 hover:border-orange-500 transition-all duration-500 shadow-2xl group">
              <div className="text-5xl mb-6 group-hover:scale-110 transition-transform origin-left">🛢️</div>
              <h4 className="text-2xl font-black text-white mb-4">Oil & Gas Tankers</h4>
              <p className="text-slate-400 text-sm mb-8 leading-relaxed">Highly secured tankers trusted by IOCL, BPCL & HPCL for petroleum, gas & edible oils.</p>
              <div className="flex flex-wrap gap-2">
                {['20 KL', '24 KL', '34 KL', '40 KL'].map(v => <span key={v} className="bg-slate-950 border border-slate-700 text-orange-400 px-3 py-1.5 rounded-lg text-xs font-black tracking-wider">{v}</span>)}
              </div>
            </div>
            
            <div className="bg-slate-900/40 backdrop-blur-md rounded-[32px] p-10 border border-slate-800 hover:border-blue-500 transition-all duration-500 shadow-2xl group">
              <div className="text-5xl mb-6 group-hover:scale-110 transition-transform origin-left">🏗️</div>
              <h4 className="text-2xl font-black text-white mb-4">Open Trucks & Trailers</h4>
              <p className="text-slate-400 text-sm mb-8 leading-relaxed">Heavy-duty flatbeds for machinery, steel, and bulk industrial goods.</p>
              <div className="flex flex-wrap gap-2">
                {['9 MT', '15 MT', '21 MT', '25+ MT'].map(v => <span key={v} className="bg-slate-950 border border-slate-700 text-blue-400 px-3 py-1.5 rounded-lg text-xs font-black tracking-wider">{v}</span>)}
              </div>
            </div>

            <div className="bg-slate-900/40 backdrop-blur-md rounded-[32px] p-10 border border-slate-800 hover:border-emerald-500 transition-all duration-500 shadow-2xl group">
              <div className="text-5xl mb-6 group-hover:scale-110 transition-transform origin-left">📦</div>
              <h4 className="text-2xl font-black text-white mb-4">Closed Containers</h4>
              <p className="text-slate-400 text-sm mb-8 leading-relaxed">Weather-proof, for FMCG, electronics, textiles, and high-value cargo.</p>
              <div className="flex flex-wrap gap-2">
                {['20 Ft', '32 Ft SXL', '32 Ft MXL', '40 Ft'].map(v => <span key={v} className="bg-slate-950 border border-slate-700 text-emerald-400 px-3 py-1.5 rounded-lg text-xs font-black tracking-wider">{v}</span>)}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 📞 6. CONTACT & WHATSAPP SUPPORT SECTION (DYNAMIC) */}
      <div id="contact" className="pt-24 pb-16 bg-white relative overflow-hidden border-t border-slate-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
          <div className="text-center mb-16">
            <h2 className="text-sm font-bold text-orange-500 tracking-widest uppercase mb-2">{siteData.contactBadge}</h2>
            <h3 className="text-4xl md:text-5xl font-black text-blue-950 tracking-tight">{siteData.contactTitle}</h3>
            <div className="w-24 h-1.5 bg-orange-500 mx-auto mt-6 rounded-full"></div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-12 items-stretch">
            
            <div className="space-y-6 flex flex-col justify-center">
              <a href={`mailto:${siteData.email1}`} className="group bg-slate-50 p-8 rounded-3xl border border-slate-100 shadow-sm hover:shadow-lg transition-all flex items-center gap-6 cursor-pointer">
                <div className="w-16 h-16 bg-blue-100 text-blue-600 rounded-2xl flex items-center justify-center text-2xl shadow-inner group-hover:scale-110 transition-transform">✉️</div>
                <div>
                  <h4 className="text-sm font-bold text-slate-500 uppercase tracking-widest mb-1">General Inquiries</h4>
                  <p className="text-blue-950 font-black text-xl group-hover:text-orange-500 transition-colors break-all">{siteData.email1}</p>
                </div>
              </a>

              <a href={`mailto:${siteData.email2}`} className="group bg-slate-50 p-8 rounded-3xl border border-slate-100 shadow-sm hover:shadow-lg transition-all flex items-center gap-6 cursor-pointer">
                <div className="w-16 h-16 bg-orange-100 text-orange-600 rounded-2xl flex items-center justify-center text-2xl shadow-inner group-hover:scale-110 transition-transform">🎧</div>
                <div>
                  <h4 className="text-sm font-bold text-slate-500 uppercase tracking-widest mb-1">Technical Support</h4>
                  <p className="text-blue-950 font-black text-xl group-hover:text-orange-500 transition-colors break-all">{siteData.email2}</p>
                </div>
              </a>
              
              <div className="bg-slate-50 p-8 rounded-3xl border border-slate-100 shadow-sm flex items-center gap-6">
                <div className="w-16 h-16 bg-green-100 text-green-600 rounded-2xl flex items-center justify-center text-2xl shadow-inner">📍</div>
                <div>
                  <h4 className="text-sm font-bold text-slate-500 uppercase tracking-widest mb-1">Head Office</h4>
                  <p className="text-blue-950 font-black text-xl">{siteData.address}</p>
                </div>
              </div>
            </div>

            <div className="bg-blue-950 rounded-3xl p-12 shadow-2xl relative overflow-hidden flex flex-col items-center justify-center text-center border-4 border-slate-800 hover:border-orange-500 transition-colors duration-500">
              <div className="absolute inset-0 opacity-10" style={{ backgroundImage: 'radial-gradient(#ffffff 1px, transparent 1px)', backgroundSize: '20px 20px' }}></div>
              <h4 className="text-3xl font-black text-white mb-2 relative z-10">Scan to WhatsApp</h4>
              <p className="text-blue-200 text-sm mb-10 relative z-10 max-w-xs leading-relaxed">Scan this QR code with your phone camera to chat instantly with Mamta AI Support.</p>
              
              <div className="bg-white p-5 rounded-3xl shadow-[0_0_40px_rgba(37,211,102,0.2)] relative z-10 transform hover:scale-105 transition duration-500 group cursor-pointer" onClick={openWhatsApp}>
                <img src={`https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=https://wa.me/${siteData.waNumber}?text=${encodeURIComponent(siteData.waMessage)}&color=0f172a`} alt="WhatsApp QR Code" className="w-48 h-48 rounded-xl" />
                <div className="absolute -bottom-6 -right-6 w-16 h-16 bg-[#25D366] rounded-full border-4 border-white flex items-center justify-center shadow-lg group-hover:scale-110 transition-transform">
                  <svg className="w-8 h-8 text-white fill-current" viewBox="0 0 24 24"><path d="M12.031 6.172c-3.181 0-5.767 2.586-5.768 5.766-.001 1.298.38 2.27 1.019 3.287l-.582 2.128 2.182-.573c.978.58 1.911.928 3.145.929 3.178 0 5.767-2.587 5.768-5.766.001-3.187-2.575-5.77-5.764-5.771zm3.392 8.244c-.144.405-.837.774-1.17.824-.299.045-.677.063-1.092-.069-.252-.08-.575-.187-.988-.365-1.739-.751-2.874-2.502-2.961-2.617-.087-.116-.708-.94-.708-1.793s.448-1.273.607-1.446c.159-.173.346-.217.462-.217l.332.006c.106.005.249-.04.39.298.144.347.491 1.2.534 1.287.043.087.072.188.014.304-.058.116-.087.188-.173.289l-.26.304c-.087.086-.177.18-.076.354.101.174.449.741.964 1.201.662.591 1.221.774 1.394.86s.274.072.376-.043c.101-.116.433-.506.549-.68.116-.173.231-.145.39-.087s1.011.477 1.184.564.289.13.332.202c.045.072.045.419-.1.824z"></path></svg>
                </div>
              </div>
              
              <button onClick={openWhatsApp} className="mt-10 bg-[#25D366] hover:bg-[#128C7E] text-white font-black py-3.5 px-10 rounded-full shadow-lg transition-all flex items-center gap-2 z-10 uppercase tracking-widest text-sm">
                Click to Chat
              </button>
            </div>

          </div>
        </div>
      </div>

      {/* 🏁 7. FOOTER (DYNAMIC) */}
      <footer className="bg-[#020617] py-12 text-center border-t border-slate-800 pb-28 md:pb-12">
        <div className="max-w-7xl mx-auto px-4">
          <h2 className="text-3xl font-black tracking-tighter text-white m-0 leading-none flex items-baseline justify-center">
            PRASAD<span className="text-orange-500 text-4xl leading-none ml-0.5 animate-pulse">.</span>
          </h2>
          <div className="mt-8 pt-8 border-t border-slate-800/50 flex justify-center items-center gap-2 text-[10px] font-bold text-slate-600 uppercase tracking-widest">
            <span>{siteData.footerText}</span>
          </div>
        </div>
      </footer>

      {/* ========================================= */}
      {/* 💬 MAMTA AI & WHATSAPP FLOATING WIDGET 💬 */}
      {/* ========================================= */}
      <div className="fixed bottom-6 right-6 z-[100] flex flex-col items-end">
        {isChatOpen && (
          <div className="bg-white w-80 rounded-3xl shadow-2xl border border-slate-200 overflow-hidden mb-4 animate-fade-in-up">
            <div className="bg-blue-950 p-5 flex justify-between items-center text-white">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-white rounded-full flex items-center justify-center text-2xl shadow-inner">🤖</div>
                <div>
                  <h4 className="font-bold text-sm leading-tight">Mamta AI</h4>
                  <p className="text-[10px] text-green-400 flex items-center gap-1.5 mt-0.5">
                    <span className="w-2 h-2 bg-green-400 rounded-full animate-pulse"></span> Online
                  </p>
                </div>
              </div>
              <button onClick={() => setIsChatOpen(false)} className="text-slate-400 hover:text-white transition text-lg">✖</button>
            </div>
            <div className="p-5 bg-slate-50 h-56 overflow-y-auto flex flex-col gap-4">
              <div className="bg-white p-4 rounded-2xl rounded-tl-none shadow-sm text-sm text-slate-700 border border-slate-100 max-w-[85%] leading-relaxed">
                Hello! I am Mamta AI, your intelligent logistics assistant. 🚚
              </div>
              <div className="bg-white p-4 rounded-2xl rounded-tl-none shadow-sm text-sm text-slate-700 border border-slate-100 max-w-[85%] leading-relaxed">
                I can help you join our network. Are you a Customer (Boss) or a Fleet Owner (Partner)?
              </div>
            </div>
            <div className="p-4 bg-white border-t border-slate-100 space-y-3">
              <button onClick={onLoginClick} className="w-full bg-blue-50 hover:bg-blue-100 text-blue-700 font-bold py-3 rounded-xl text-xs uppercase tracking-widest border border-blue-100 transition">
                Register / Login Now
              </button>
              <button onClick={openWhatsApp} className="w-full bg-[#25D366] hover:bg-[#128C7E] text-white font-bold py-3 rounded-xl text-xs uppercase tracking-widest transition shadow-md flex justify-center items-center gap-2">
                <svg className="w-4 h-4 fill-current" viewBox="0 0 24 24"><path d="M12.031 6.172c-3.181 0-5.767 2.586-5.768 5.766-.001 1.298.38 2.27 1.019 3.287l-.582 2.128 2.182-.573c.978.58 1.911.928 3.145.929 3.178 0 5.767-2.587 5.768-5.766.001-3.187-2.575-5.77-5.764-5.771zm3.392 8.244c-.144.405-.837.774-1.17.824-.299.045-.677.063-1.092-.069-.252-.08-.575-.187-.988-.365-1.739-.751-2.874-2.502-2.961-2.617-.087-.116-.708-.94-.708-1.793s.448-1.273.607-1.446c.159-.173.346-.217.462-.217l.332.006c.106.005.249-.04.39.298.144.347.491 1.2.534 1.287.043.087.072.188.014.304-.058.116-.087.188-.173.289l-.26.304c-.087.086-.177.18-.076.354.101.174.449.741.964 1.201.662.591 1.221.774 1.394.86s.274.072.376-.043c.101-.116.433-.506.549-.68.116-.173.231-.145.39-.087s1.011.477 1.184.564.289.13.332.202c.045.072.045.419-.1.824z"></path></svg>
                Chat on WhatsApp
              </button>
            </div>
          </div>
        )}
        <button onClick={() => setIsChatOpen(!isChatOpen)} className="relative bg-gradient-to-br from-orange-500 to-orange-600 text-white w-16 h-16 rounded-full shadow-[0_10px_30px_rgba(249,115,22,0.6)] flex items-center justify-center text-3xl hover:scale-110 transition-transform duration-300 z-50 border-4 border-white">
          {isChatOpen ? '✖' : '🤖'}
          {!isChatOpen && <span className="absolute top-0 right-0 w-4 h-4 bg-green-500 border-2 border-white rounded-full animate-pulse"></span>}
        </button>
      </div>

      <style>{`
        @keyframes shimmer { 100% { transform: translateX(100%); } }
        html { scroll-behavior: smooth; }
        .animate-fade-in-up { animation: fadeInUp 0.4s ease-out forwards; }
        @keyframes fadeInUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>
    </div>
  );
}