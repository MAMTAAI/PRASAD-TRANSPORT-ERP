import React, { useState } from 'react';

interface AdminProps {
  userData: any;
  onLogout: () => void;
  onGoToERP: () => void;
}

export default function AdminDashboard({ userData, onLogout, onGoToERP }: AdminProps) {
  const [activeTab, setActiveTab] = useState('dashboard');

  // 📝 DUMMY DATA FOR DASHBOARD
  const pendingApprovals = [
    { id: 1, name: 'Sharma Logistics', type: 'Fleet Owner', date: '22 Mar 2026', status: 'Pending KYC' },
    { id: 2, name: 'Reliance Industries', type: 'Customer', date: '22 Mar 2026', status: 'Pending GST' },
    { id: 3, name: 'Verma Transport', type: 'Fleet Owner', date: '21 Mar 2026', status: 'Pending RC' },
  ];

  // 📝 DUMMY DATA FOR CUSTOMERS
  const customerList = [
    { id: 'C-1001', company: 'Reliance Industries', contact: 'Rajesh Verma', phone: '+91 9876543210', gst: '22AAAAA0000A1Z5', status: 'Verified ✅', loads: 12, escrow: '₹4.5 L' },
    { id: 'C-1002', company: 'Tata Steel', contact: 'Amit Kumar', phone: '+91 9123456789', gst: '20BBBBB0000B1Z5', status: 'Verified ✅', loads: 8, escrow: '₹2.1 L' },
    { id: 'C-1003', company: 'ABC Manufacturing', contact: 'Suresh Das', phone: '+91 9998887776', gst: 'Pending', status: 'Pending KYC ⏳', loads: 0, escrow: '₹0' },
  ];

  // 📝 DUMMY DATA FOR FLEETS
  const fleetList = [
    { id: 'F-2001', name: 'Sharma Logistics', owner: 'Ramesh Sharma', phone: '+91 9988776655', trucks: 14, status: 'Verified ✅', trips: 45 },
    { id: 'F-2002', name: 'Yadav Transports', owner: 'Rakesh Yadav', phone: '+91 8877665544', trucks: 3, status: 'Verified ✅', trips: 12 },
    { id: 'F-2003', name: 'Verma Transport', owner: 'Sunil Verma', phone: '+91 7766554433', trucks: 1, status: 'Pending RC ⏳', trips: 0 },
  ];

  return (
    <div className="min-h-screen bg-slate-50 flex font-sans selection:bg-orange-500 selection:text-white">
      
      {/* 🚀 LEFT SIDEBAR (DARK THEME) */}
      <aside className="w-72 bg-[#020617] text-white flex flex-col shadow-2xl z-20 relative">
        <div className="absolute inset-0 bg-[radial-gradient(#ffffff_1px,transparent_1px)] [background-size:20px_20px] opacity-[0.03]"></div>
        
        {/* BRANDING */}
        <div className="p-6 flex items-center gap-3 border-b border-slate-800/50 relative z-10">
          <div className="bg-gradient-to-br from-orange-500 to-orange-700 w-10 h-10 rounded-xl flex items-center justify-center shadow-lg shadow-orange-500/20 text-white font-black text-xl">
            P
          </div>
          <div>
            <h1 className="text-xl font-black tracking-tighter leading-none m-0">PRASAD<span className="text-orange-500">.</span></h1>
            <h2 className="text-[9px] font-bold text-slate-400 tracking-[0.2em] uppercase mt-1">Control Room</h2>
          </div>
        </div>

        {/* MENU ITEMS */}
        <nav className="flex-1 p-4 space-y-2 relative z-10 overflow-y-auto">
          
          <button onClick={onGoToERP} className="w-full flex items-center justify-center gap-2 px-4 py-3 mb-6 rounded-xl font-black bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-600/30 transition-all border border-blue-500 hover:-translate-y-0.5">
            ⬅️ Go to Main ERP
          </button>

          <p className="text-xs font-bold text-slate-500 uppercase tracking-widest mb-4 ml-2">Main Menu</p>
          
          <button onClick={() => setActiveTab('dashboard')} className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl font-bold transition-all ${activeTab === 'dashboard' ? 'bg-orange-500 text-white shadow-[0_0_15px_rgba(249,115,22,0.4)]' : 'text-slate-400 hover:bg-slate-800 hover:text-white'}`}>
            <span className="text-xl">📊</span> Dashboard
          </button>
          
          <button onClick={() => setActiveTab('approvals')} className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl font-bold transition-all ${activeTab === 'approvals' ? 'bg-orange-500 text-white shadow-[0_0_15px_rgba(249,115,22,0.4)]' : 'text-slate-400 hover:bg-slate-800 hover:text-white'}`}>
            <span className="text-xl">✅</span> KYC Approvals <span className="ml-auto bg-red-500 text-white text-[10px] px-2 py-0.5 rounded-full">3</span>
          </button>

          <button onClick={() => setActiveTab('customers')} className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl font-bold transition-all ${activeTab === 'customers' ? 'bg-orange-500 text-white shadow-[0_0_15px_rgba(249,115,22,0.4)]' : 'text-slate-400 hover:bg-slate-800 hover:text-white'}`}>
            <span className="text-xl">🏢</span> Customers (Boss)
          </button>

          <button onClick={() => setActiveTab('fleets')} className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl font-bold transition-all ${activeTab === 'fleets' ? 'bg-orange-500 text-white shadow-[0_0_15px_rgba(249,115,22,0.4)]' : 'text-slate-400 hover:bg-slate-800 hover:text-white'}`}>
            <span className="text-xl">🚛</span> Fleet Partners
          </button>

          <button onClick={() => setActiveTab('loads')} className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl font-bold transition-all ${activeTab === 'loads' ? 'bg-orange-500 text-white shadow-[0_0_15px_rgba(249,115,22,0.4)]' : 'text-slate-400 hover:bg-slate-800 hover:text-white'}`}>
            <span className="text-xl">📦</span> Live Load Board
          </button>

          <button onClick={() => setActiveTab('escrow')} className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl font-bold transition-all ${activeTab === 'escrow' ? 'bg-orange-500 text-white shadow-[0_0_15px_rgba(249,115,22,0.4)]' : 'text-slate-400 hover:bg-slate-800 hover:text-white'}`}>
            <span className="text-xl">💰</span> Escrow & Finance
          </button>
        </nav>

        {/* ADMIN PROFILE BOTTOM */}
        <div className="p-4 border-t border-slate-800/50 relative z-10">
          <div className="bg-slate-800/50 p-4 rounded-2xl flex items-center gap-3 border border-slate-700/50">
            <div className="w-10 h-10 bg-blue-500 rounded-full flex items-center justify-center text-white font-black shadow-inner">👑</div>
            <div className="flex-1 overflow-hidden">
              <h4 className="text-sm font-black text-white truncate">{userData?.name || 'Super Admin'}</h4>
              <p className="text-[10px] text-green-400 font-bold uppercase tracking-wider flex items-center gap-1">
                <span className="w-1.5 h-1.5 bg-green-400 rounded-full animate-pulse"></span> Online
              </p>
            </div>
            <button onClick={onLogout} className="w-8 h-8 bg-red-500/10 text-red-500 hover:bg-red-500 hover:text-white rounded-lg flex items-center justify-center transition-colors" title="Logout">🚪</button>
          </div>
        </div>
      </aside>

      {/* 🚀 MAIN CONTENT AREA */}
      <main className="flex-1 flex flex-col h-screen overflow-hidden bg-slate-50 relative">
        
        {/* TOP HEADER */}
        <header className="h-20 bg-white border-b border-slate-200 flex items-center justify-between px-8 shadow-sm z-10 shrink-0">
          <div>
            <h2 className="text-2xl font-black text-blue-950">Welcome Back, Boss! 🚀</h2>
            <p className="text-sm text-slate-500 font-medium mt-0.5">Here is what's happening in your ecosystem today.</p>
          </div>
          <div className="flex items-center gap-4">
            <button className="relative w-10 h-10 bg-slate-100 text-slate-600 hover:bg-orange-100 hover:text-orange-600 rounded-full flex items-center justify-center text-xl transition-colors">
              🔔<span className="absolute top-0 right-0 w-3 h-3 bg-red-500 border-2 border-white rounded-full"></span>
            </button>
            <button className="bg-blue-950 hover:bg-blue-900 text-white px-5 py-2 rounded-xl text-sm font-bold shadow-md transition-colors">
              + Add Staff
            </button>
          </div>
        </header>

        {/* SCROLLABLE CONTENT */}
        <div className="flex-1 overflow-y-auto p-8 relative">
          
          <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 text-[300px] opacity-[0.02] font-black pointer-events-none select-none">
            P.
          </div>

          {/* 📊 TAB 1: DASHBOARD */}
          {activeTab === 'dashboard' && (
            <div className="space-y-8 relative z-10 animate-fade-in-up">
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                <div className="bg-white p-6 rounded-3xl border border-slate-100 shadow-sm hover:shadow-xl transition-shadow flex flex-col justify-between group">
                  <div className="flex justify-between items-start mb-4">
                    <div className="w-12 h-12 bg-blue-100 text-blue-600 rounded-2xl flex items-center justify-center text-2xl group-hover:scale-110 transition-transform">🏢</div>
                    <span className="bg-green-100 text-green-700 text-[10px] font-bold px-2 py-1 rounded-lg">+12%</span>
                  </div>
                  <div>
                    <h3 className="text-slate-500 text-xs font-bold tracking-widest uppercase mb-1">Total Customers</h3>
                    <p className="text-3xl font-black text-blue-950">1,248</p>
                  </div>
                </div>

                <div className="bg-white p-6 rounded-3xl border border-slate-100 shadow-sm hover:shadow-xl transition-shadow flex flex-col justify-between group">
                  <div className="flex justify-between items-start mb-4">
                    <div className="w-12 h-12 bg-orange-100 text-orange-600 rounded-2xl flex items-center justify-center text-2xl group-hover:scale-110 transition-transform">🚛</div>
                    <span className="bg-green-100 text-green-700 text-[10px] font-bold px-2 py-1 rounded-lg">+5%</span>
                  </div>
                  <div>
                    <h3 className="text-slate-500 text-xs font-bold tracking-widest uppercase mb-1">Verified Fleets</h3>
                    <p className="text-3xl font-black text-blue-950">3,890</p>
                  </div>
                </div>

                <div className="bg-white p-6 rounded-3xl border border-slate-100 shadow-sm hover:shadow-xl transition-shadow flex flex-col justify-between group">
                  <div className="flex justify-between items-start mb-4">
                    <div className="w-12 h-12 bg-purple-100 text-purple-600 rounded-2xl flex items-center justify-center text-2xl group-hover:scale-110 transition-transform">📦</div>
                    <span className="bg-blue-100 text-blue-700 text-[10px] font-bold px-2 py-1 rounded-lg">Live</span>
                  </div>
                  <div>
                    <h3 className="text-slate-500 text-xs font-bold tracking-widest uppercase mb-1">Active Live Loads</h3>
                    <p className="text-3xl font-black text-blue-950">142</p>
                  </div>
                </div>

                <div className="bg-gradient-to-br from-blue-950 to-blue-900 p-6 rounded-3xl border border-blue-800 shadow-lg hover:shadow-2xl transition-shadow flex flex-col justify-between relative overflow-hidden group">
                  <div className="absolute top-0 right-0 w-24 h-24 bg-white/5 rounded-full blur-xl -mr-5 -mt-5"></div>
                  <div className="flex justify-between items-start mb-4 relative z-10">
                    <div className="w-12 h-12 bg-blue-800 text-white rounded-2xl flex items-center justify-center text-2xl border border-blue-700 group-hover:scale-110 transition-transform">💰</div>
                  </div>
                  <div className="relative z-10">
                    <h3 className="text-blue-300 text-xs font-bold tracking-widest uppercase mb-1">Escrow Balance</h3>
                    <p className="text-3xl font-black text-white">₹84.5 L</p>
                  </div>
                </div>
              </div>

              {/* PENDING APPROVALS */}
              <div className="bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden">
                <div className="p-6 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 bg-red-100 text-red-600 rounded-lg flex items-center justify-center text-lg">⚠️</div>
                    <h3 className="text-lg font-black text-blue-950">Pending Approvals</h3>
                  </div>
                  <button className="text-sm font-bold text-blue-600 hover:text-blue-800">View All →</button>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="bg-slate-50 text-slate-500 text-xs uppercase tracking-widest">
                        <th className="p-4 font-bold">User / Company Name</th>
                        <th className="p-4 font-bold">Role Type</th>
                        <th className="p-4 font-bold">Date Registered</th>
                        <th className="p-4 font-bold">Status</th>
                        <th className="p-4 font-bold text-center">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {pendingApprovals.map((user) => (
                        <tr key={user.id} className="hover:bg-slate-50/80 transition-colors">
                          <td className="p-4 font-black text-blue-950">{user.name}</td>
                          <td className="p-4">
                            <span className={`px-3 py-1 rounded-full text-xs font-bold ${user.type === 'Customer' ? 'bg-blue-100 text-blue-700' : 'bg-orange-100 text-orange-700'}`}>{user.type}</span>
                          </td>
                          <td className="p-4 text-sm text-slate-600 font-medium">{user.date}</td>
                          <td className="p-4">
                            <span className="bg-yellow-100 text-yellow-700 px-3 py-1 rounded-full text-xs font-bold border border-yellow-200 flex items-center gap-1.5 w-max">
                              <span className="w-1.5 h-1.5 rounded-full bg-yellow-500 animate-pulse"></span> {user.status}
                            </span>
                          </td>
                          <td className="p-4 flex gap-2 justify-center">
                            <button className="bg-green-100 hover:bg-green-500 text-green-700 hover:text-white px-4 py-2 rounded-lg text-xs font-bold transition-colors">Approve</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* 🏢 TAB 2: CUSTOMERS (BOSS) */}
          {activeTab === 'customers' && (
            <div className="space-y-6 relative z-10 animate-fade-in-up">
              <div className="flex justify-between items-end mb-6">
                <div>
                  <h2 className="text-3xl font-black text-blue-950">Customer Management</h2>
                  <p className="text-sm text-slate-500 mt-1">Manage corporate clients and load providers (The Bosses).</p>
                </div>
                <button className="bg-blue-600 hover:bg-blue-700 text-white font-bold px-5 py-2.5 rounded-xl text-sm shadow-lg transition-transform hover:-translate-y-0.5">
                  + Add Corporate Customer
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
                <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm flex items-center gap-4">
                  <div className="w-12 h-12 bg-blue-100 text-blue-600 rounded-xl flex items-center justify-center text-2xl">🏢</div>
                  <div><p className="text-xs font-bold text-slate-400 uppercase">Total Companies</p><p className="text-2xl font-black text-blue-950">482</p></div>
                </div>
                <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm flex items-center gap-4">
                  <div className="w-12 h-12 bg-green-100 text-green-600 rounded-xl flex items-center justify-center text-2xl">✅</div>
                  <div><p className="text-xs font-bold text-slate-400 uppercase">GST Verified</p><p className="text-2xl font-black text-blue-950">450</p></div>
                </div>
                <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm flex items-center gap-4">
                  <div className="w-12 h-12 bg-purple-100 text-purple-600 rounded-xl flex items-center justify-center text-2xl">📦</div>
                  <div><p className="text-xs font-bold text-slate-400 uppercase">Total Loads Posted</p><p className="text-2xl font-black text-blue-950">8,405</p></div>
                </div>
              </div>

              <div className="bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="bg-slate-50 text-slate-500 text-xs uppercase tracking-widest">
                        <th className="p-4 font-bold border-b border-slate-200">Company Name & ID</th>
                        <th className="p-4 font-bold border-b border-slate-200">Contact Person</th>
                        <th className="p-4 font-bold border-b border-slate-200">GST / Status</th>
                        <th className="p-4 font-bold border-b border-slate-200">Escrow Held</th>
                        <th className="p-4 font-bold border-b border-slate-200 text-center">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {customerList.map((cust) => (
                        <tr key={cust.id} className="hover:bg-slate-50 transition-colors">
                          <td className="p-4">
                            <p className="font-black text-blue-950 text-sm">{cust.company}</p>
                            <p className="text-xs text-slate-500 font-bold mt-0.5">{cust.id}</p>
                          </td>
                          <td className="p-4">
                            <p className="text-sm font-bold text-slate-700">{cust.contact}</p>
                            <p className="text-xs text-slate-500 mt-0.5">{cust.phone}</p>
                          </td>
                          <td className="p-4">
                            <p className="text-xs font-bold text-slate-600 font-mono bg-slate-100 px-2 py-1 rounded w-max mb-1">{cust.gst}</p>
                            <p className={`text-xs font-bold ${cust.status.includes('Verified') ? 'text-green-600' : 'text-orange-500'}`}>{cust.status}</p>
                          </td>
                          <td className="p-4 font-black text-blue-700">{cust.escrow}</td>
                          <td className="p-4 flex gap-2 justify-center">
                            <button className="bg-blue-50 text-blue-600 hover:bg-blue-600 hover:text-white px-3 py-1.5 rounded-lg text-xs font-bold transition-colors">View</button>
                            <button className="bg-red-50 text-red-600 hover:bg-red-500 hover:text-white px-3 py-1.5 rounded-lg text-xs font-bold transition-colors">Block</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* 🚛 TAB 3: FLEET PARTNERS */}
          {activeTab === 'fleets' && (
            <div className="space-y-6 relative z-10 animate-fade-in-up">
              <div className="flex justify-between items-end mb-6">
                <div>
                  <h2 className="text-3xl font-black text-blue-950">Fleet Network</h2>
                  <p className="text-sm text-slate-500 mt-1">Manage verified truck owners and transport partners.</p>
                </div>
                <button className="bg-orange-500 hover:bg-orange-600 text-white font-bold px-5 py-2.5 rounded-xl text-sm shadow-lg transition-transform hover:-translate-y-0.5">
                  + Add Fleet Partner
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
                <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm flex items-center gap-4">
                  <div className="w-12 h-12 bg-orange-100 text-orange-600 rounded-xl flex items-center justify-center text-2xl">🚛</div>
                  <div><p className="text-xs font-bold text-slate-400 uppercase">Registered Partners</p><p className="text-2xl font-black text-blue-950">1,540</p></div>
                </div>
                <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm flex items-center gap-4">
                  <div className="w-12 h-12 bg-green-100 text-green-600 rounded-xl flex items-center justify-center text-2xl">📋</div>
                  <div><p className="text-xs font-bold text-slate-400 uppercase">Total Verified Trucks</p><p className="text-2xl font-black text-blue-950">3,890</p></div>
                </div>
                <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm flex items-center gap-4">
                  <div className="w-12 h-12 bg-blue-100 text-blue-600 rounded-xl flex items-center justify-center text-2xl">🛣️</div>
                  <div><p className="text-xs font-bold text-slate-400 uppercase">Trips Completed</p><p className="text-2xl font-black text-blue-950">14,200</p></div>
                </div>
              </div>

              <div className="bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="bg-slate-50 text-slate-500 text-xs uppercase tracking-widest">
                        <th className="p-4 font-bold border-b border-slate-200">Partner Details</th>
                        <th className="p-4 font-bold border-b border-slate-200">Registered Trucks</th>
                        <th className="p-4 font-bold border-b border-slate-200">Trips Done</th>
                        <th className="p-4 font-bold border-b border-slate-200">KYC Status</th>
                        <th className="p-4 font-bold border-b border-slate-200 text-center">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {fleetList.map((fleet) => (
                        <tr key={fleet.id} className="hover:bg-slate-50 transition-colors">
                          <td className="p-4">
                            <p className="font-black text-blue-950 text-sm">{fleet.name}</p>
                            <p className="text-xs text-slate-500 font-bold mt-0.5">{fleet.owner} • {fleet.phone}</p>
                          </td>
                          <td className="p-4">
                            <span className="bg-slate-100 text-slate-700 px-3 py-1 rounded-full font-black text-sm">{fleet.trucks} Trucks</span>
                          </td>
                          <td className="p-4 font-bold text-slate-600">{fleet.trips}</td>
                          <td className="p-4">
                            <p className={`text-xs font-bold ${fleet.status.includes('Verified') ? 'text-green-600' : 'text-orange-500'}`}>{fleet.status}</p>
                          </td>
                          <td className="p-4 flex gap-2 justify-center">
                            <button className="bg-blue-50 text-blue-600 hover:bg-blue-600 hover:text-white px-3 py-1.5 rounded-lg text-xs font-bold transition-colors">View Fleet</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* 🛠️ PLACEHOLDER FOR OTHER TABS */}
          {['approvals', 'loads', 'escrow'].includes(activeTab) && (
            <div className="flex flex-col items-center justify-center h-[60vh] text-center relative z-10 animate-fade-in-up">
              <div className="text-6xl mb-4 opacity-50">🛠️</div>
              <h2 className="text-2xl font-black text-blue-950">Module Under Construction</h2>
              <p className="text-slate-500 mt-2 font-medium">We are currently building the <span className="capitalize text-orange-500 font-bold">{activeTab.replace('_', ' ')}</span> section.</p>
            </div>
          )}

        </div>
      </main>

      <style>{`
        .animate-fade-in-up { animation: fadeInUp 0.3s ease-out forwards; }
        @keyframes fadeInUp { from { opacity: 0; transform: translateY(15px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>
    </div>
  );
}