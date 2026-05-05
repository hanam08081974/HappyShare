import React, { useState, useMemo, useEffect } from "react";
import { initializeApp } from "firebase/app";
import { getAuth, onAuthStateChanged, signInWithPopup, GoogleAuthProvider, signOut, User as FirebaseUser } from "firebase/auth";
import { getFirestore, collection, doc, setDoc, getDoc, getDocs, onSnapshot, query, where, addDoc, updateDoc, deleteDoc, serverTimestamp, getDocFromServer, orderBy } from "firebase/firestore";
import firebaseConfig from "../firebase-applet-config.json";

// Initialize Firebase
const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);
const googleProvider = new GoogleAuthProvider();

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
    },
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// Test connection
async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if(error instanceof Error && error.message.includes('the client is offline')) {
      console.error("Please check your Firebase configuration.");
    }
  }
}
testConnection();

// ─── Constants ───────────────────────────────────────────────
const COLORS = ["#7C3AED","#2563EB","#DB2777","#D97706","#059669","#DC2626","#0891B2","#9333EA","#EA580C","#0D9488"];
const EMOJIS = ["🏖️","🍜","🎉","✈️","🏠","🎮","🛒","🍻","🏕️","💼"];
const fmt = (n: number) => new Intl.NumberFormat("vi-VN",{style:"currency",currency:"VND"}).format(Math.round(n));
const fmtShort = (n: number) => { if(Math.abs(n)>=1e6) return (n/1e6).toFixed(1)+"tr"; if(Math.abs(n)>=1e3) return (n/1e3).toFixed(0)+"k"; return String(Math.round(n)); };
const timeAgo = (ts: number) => { const s=Math.floor((Date.now()-ts)/1000); if(s<60)return"vừa xong"; if(s<3600)return`${Math.floor(s/60)}p trước`; if(s<86400)return`${Math.floor(s/3600)}h trước`; return`${Math.floor(s/86400)}d trước`; };
const genCode = () => Math.random().toString(36).slice(2,8).toUpperCase();

// ─── Types ───────────────────────────────────────────────────
interface Friend {
  name: string;
  phone: string;
  email: string;
}

interface Expense {
  id: string;
  desc: string;
  amount: number;
  payers: Record<string, number>; // Multiple payers: { name: amount }
  splitMode: string;
  splits: Record<string, number>;
  ts: number;
}

// ─── Utilities ──────────────────────────────────────────────
const computeGroupBalances = (group: Group) => {
  const members = group.members;
  const expenses = group.expenses || [];
  const payments = group.payments || [];
  
  if (!members.length) return { total: 0, balances: {}, transactions: [] };
  
  const getMemberShare = (exp: Expense, m: string) => {
    if (exp.splitMode === "equal") return exp.amount / members.length;
    if (exp.splitMode === "percent") return (exp.splits[m] || 0) / 100 * exp.amount;
    if (exp.splitMode === "adjust") return exp.amount / members.length + (exp.splits[m] || 0);
    return 0;
  };

  const total = expenses.reduce((s, e) => s + e.amount, 0);
  const paid: Record<string, number> = {};
  members.forEach(m => paid[m] = 0);
  expenses.forEach(e => {
    Object.entries(e.payers).forEach(([name, amt]) => {
      if (paid[name] !== undefined) paid[name] += amt as number;
    });
  });

  const adj: Record<string, number> = {};
  members.forEach(m => {
    let owed = 0;
    expenses.forEach(e => { owed += getMemberShare(e, m); });
    adj[m] = (paid[m] || 0) - owed;
  });

  payments.forEach(p => {
    if (adj[p.from] !== undefined) adj[p.from] += p.amount;
    if (adj[p.to] !== undefined) adj[p.to] -= p.amount;
  });

  const c = members.filter(m => adj[m] > 0.01).map(m => ({ name: m, amt: adj[m] })).sort((a, b) => b.amt - a.amt);
  const d = members.filter(m => adj[m] < -0.01).map(m => ({ name: m, amt: -adj[m] })).sort((a, b) => b.amt - a.amt);
  const txns: any[] = [];
  let ci = 0, di = 0;
  while (ci < c.length && di < d.length) {
    const s = Math.min(c[ci].amt, d[di].amt);
    txns.push({ from: d[di].name, to: c[ci].name, amount: s });
    c[ci].amt -= s;
    if (c[ci].amt < 0.01) ci++;
    d[di].amt -= s;
    if (d[di].amt < 0.01) di++;
  }

  return { total, balances: adj, transactions: txns };
};

interface Payment {
  id: string;
  from: string;
  to: string;
  amount: number;
  note: string;
  ts: number;
}

interface FeedItem {
  id: string;
  type: string;
  text: string;
  ts: number;
  icon?: string;
  name?: string;
}

interface Group {
  id: string;
  name: string;
  emoji: string;
  members: string[];
  memberUids: string[];
  memberDetails?: Record<string, { phone?: string; email?: string }>;
  leader: string;
  expenses?: Expense[];
  payments?: Payment[];
  feed?: FeedItem[];
  inviteCode: string;
  dueDate: string;
}

// ─── Tiny Components ─────────────────────────────────────────
function Av({ name, size=36, ci=0, style={} }: { name: string, size?: number, ci?: number, style?: any }) {
  const ini = name.trim().split(" ").map(w=>w[0]).join("").toUpperCase().slice(0,2);
  return <div style={{width:size,height:size,borderRadius:"50%",background:COLORS[ci%COLORS.length],display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontWeight:700,fontSize:size*.38,flexShrink:0,...style}}>{ini||"?"}</div>;
}
function Card({ children, style={}, onClick }: { children: React.ReactNode, style?: any, onClick?: () => void, key?: any }) {
  return <div onClick={onClick} style={{background:"#fff",borderRadius:16,boxShadow:"0 4px 24px rgba(120,60,220,.10)",padding:"16px",marginBottom:10,...style,cursor:onClick?"pointer":"default"}}>{children}</div>;
}
function SecTitle({ icon, title, color, right }: { icon: string, title: string, color: string, right?: React.ReactNode }) {
  return <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12}}><div style={{width:30,height:30,borderRadius:9,background:color+"20",display:"flex",alignItems:"center",justifyContent:"center",fontSize:15}}>{icon}</div><span style={{fontWeight:700,fontSize:14,color:"#3b1e6e",flex:1}}>{title}</span>{right}</div>;
}
function Btn({ children, onClick, color="#7c3aed", disabled=false, style={} }: { children: React.ReactNode, onClick: () => void, color?: string, disabled?: boolean, style?: any }) {
  return <button onClick={onClick} disabled={disabled} style={{background:disabled?"#e2e8f0":color,color:disabled?"#94a3b8":"#fff",border:"none",borderRadius:11,padding:"11px 16px",fontWeight:700,fontSize:13,cursor:disabled?"not-allowed":"pointer",...style}}>{children}</button>;
}
function Input({ style={}, ...p }: any) {
  return <input {...p} style={{border:"2px solid #ede9fe",borderRadius:10,padding:"9px 11px",fontSize:13,outline:"none",width:"100%",boxSizing:"border-box",...style}}/>;
}

// ─── Charts ──────────────────────────────────────────────────
function PieChart({ data, size=120 }: { data: {value: number, color: string, label: string}[], size?: number }) {
  if (!data.length) return null;
  const total = data.reduce((s,d)=>s+d.value,0);
  if (!total) return null;
  let angle = -Math.PI/2;
  const cx=size/2, cy=size/2, r=size/2-4;
  const slices = data.map(d => {
    const sweep = (d.value/total)*2*Math.PI;
    const x1=cx+r*Math.cos(angle), y1=cy+r*Math.sin(angle);
    angle+=sweep;
    const x2=cx+r*Math.cos(angle), y2=cy+r*Math.sin(angle);
    const large=sweep>Math.PI?1:0;
    return {path:`M${cx},${cy} L${x1},${y1} A${r},${r},0,${large},1,${x2},${y2} Z`, color:d.color, label:d.label, pct:Math.round(d.value/total*100)};
  });
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      {slices.map((s,i)=><path key={i} d={s.path} fill={s.color} stroke="#fff" strokeWidth={1.5}/>)}
      <circle cx={cx} cy={cy} r={r*0.45} fill="#fff"/>
    </svg>
  );
}
function BarChart({ data, maxVal }: { data: {value: number, color: string, label: string}[], maxVal?: number }) {
  const mv = maxVal || Math.max(...data.map(d=>d.value),1);
  return (
    <div style={{display:"flex",alignItems:"flex-end",gap:6,height:80}}>
      {data.map((d,i)=>(
        <div key={i} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:3}}>
          <div style={{fontSize:9,fontWeight:700,color:d.color}}>{fmtShort(d.value)}</div>
          <div style={{width:"100%",background:d.color,borderRadius:"4px 4px 0 0",height:Math.max(4,(d.value/mv)*60),transition:"height .4s"}}/>
          <div style={{fontSize:9,color:"#64748b",fontWeight:600,textAlign:"center",lineHeight:1.2,maxWidth:36,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{d.label}</div>
        </div>
      ))}
    </div>
  );
}

// ─── Modals ───────────────────────────────────────────────────
function Modal({ children, onClose }: { children: React.ReactNode, onClose: () => void }) {
  return (
    <div onClick={onClose} style={{position:"fixed",inset:0,background:"rgba(76,29,149,.55)",display:"flex",alignItems:"flex-end",justifyContent:"center",zIndex:300,backdropFilter:"blur(4px)"}}>
      <div onClick={e=>e.stopPropagation()} style={{background:"#fff",borderRadius:"22px 22px 0 0",padding:"22px 18px 36px",width:"100%",maxWidth:520,boxShadow:"0 -8px 40px rgba(124,58,237,.2)",maxHeight:"88vh",overflowY:"auto"}}>
        <div style={{width:38,height:4,background:"#e2e8f0",borderRadius:4,margin:"0 auto 18px"}}/>
        {children}
      </div>
    </div>
  );
}

function BillDetailModal({ bill, members, onClose }: { bill: Expense, members: string[], onClose: () => void }) {
  if (!bill) return null;
  const { splitMode, splits, amount, payers } = bill;
  const getMemberShare = (m: string) => {
    if (splitMode === "equal") return amount / members.length;
    if (splitMode === "percent") return (splits[m] || 0) / 100 * amount;
    if (splitMode === "adjust") { const base = amount / members.length; return base + (splits[m] || 0); }
    return 0;
  };
  const payerEntries = Object.entries(payers).filter(([_, amt]) => (amt || 0) > 0);

  return (
    <Modal onClose={onClose}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
        <div style={{ width: 46, height: 46, borderRadius: 13, background: "#ede9fe", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22 }}>🧾</div>
        <div>
          <div style={{ fontWeight: 800, fontSize: 16 }}>{bill.desc}</div>
          <div style={{ fontSize: 11, color: "#94a3b8" }}>{timeAgo(bill.ts)} · {splitMode === "equal" ? "Chia đều" : splitMode === "percent" ? "Theo %" : "Có điều chỉnh"}</div>
        </div>
      </div>
      <div style={{ background: "linear-gradient(135deg,#7c3aed,#a78bfa)", borderRadius: 12, padding: "12px 16px", marginBottom: 14, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ color: "#ddd6fe", fontSize: 12, fontWeight: 600 }}>Tổng hóa đơn</span>
        <span style={{ color: "#fff", fontWeight: 800, fontSize: 20 }}>{fmt(amount)}</span>
      </div>
      
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#7c3aed", textTransform: "uppercase", letterSpacing: 1, marginBottom: 7 }}>Đã thanh toán ({payerEntries.length})</div>
        {payerEntries.map(([name, amt], i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, background: "#f5f3ff", borderRadius: 11, padding: "9px 13px", marginBottom: 5 }}>
            <Av name={name} size={34} ci={members.indexOf(name)} />
            <div style={{ flex: 1 }}><div style={{ fontWeight: 700, fontSize: 13 }}>{name}</div></div>
            <span style={{ fontWeight: 800, fontSize: 14, color: "#7c3aed" }}>{fmt(amt)}</span>
          </div>
        ))}
      </div>

      <div>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#dc2626", textTransform: "uppercase", letterSpacing: 1, marginBottom: 7 }}>Phân chia</div>
        {members.map((m, i) => {
          const share = getMemberShare(m);
          const paid = payers[m] || 0;
          const diff = paid - share;
          return (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 9, background: diff >= 0 ? "#f0fdf4" : "#fef2f2", borderRadius: 11, padding: "9px 13px", marginBottom: 5, border: `1.5px solid ${diff >= 0 ? "#bbf7d0" : "#fecaca"}` }}>
              <Av name={m} size={32} ci={members.indexOf(m)} />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{m}</div>
                <div style={{ fontSize: 10, color: "#94a3b8" }}>{diff >= 0 ? "Dư" : "Nợ"}: {fmt(Math.abs(diff))}</div>
              </div>
              <span style={{ fontWeight: 800, fontSize: 13, color: diff >= 0 ? "#16a34a" : "#dc2626" }}>{fmt(share)}</span>
            </div>
          );
        })}
      </div>
      <Btn onClick={onClose} color="#94a3b8" style={{ width: "100%", marginTop: 14 }}>Đóng</Btn>
    </Modal>
  );
}

function AddExpenseModal({ members, onAdd, onClose }: { members: string[], onAdd: (e: Expense) => void, onClose: () => void }) {
  const [desc, setDesc] = useState("");
  const [amount, setAmount] = useState("");
  const [payers, setPayers] = useState<Record<string, number>>({});

  const amt = parseFloat(amount) || 0;

  useEffect(() => {
    const keys = Object.keys(payers);
    if (!amt) {
      setPayers({});
      return;
    }
    if (keys.length === 1) {
      setPayers({ [keys[0]]: amt });
    } else if (keys.length > 1) {
      const share = amt / members.length;
      const p: any = {};
      members.forEach(m => p[m] = share);
      setPayers(p);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amt]);

  const [mode, setMode] = useState("equal");
  const [splits, setSplits] = useState<Record<string, number>>({});

  const payerVals = Object.values(payers) as number[];
  const totalPaid = payerVals.reduce((s: number, v: number) => s + (v || 0), 0);

  const updateSplit = (m: string, val: string) => setSplits(s => ({ ...s, [m]: parseFloat(val) || 0 }));

  const totalPct = members.reduce((s: number, m: string) => s + (splits[m] || 0), 0);
  const totalAdj = members.reduce((s: number, m: string) => s + (splits[m] || 0), 0);

  const valid = desc.trim() && amt > 0 && Math.abs(totalPaid - amt) < 1 && (
    mode === "equal" ||
    (mode === "percent" && Math.abs(totalPct - 100) < 0.01) ||
    (mode === "adjust" && Math.abs(totalAdj) < 0.01)
  );

  const handleAdd = () => {
    if (!valid) return;
    onAdd({ id: String(Date.now()), desc: desc.trim(), amount: amt, payers: { ...payers }, splitMode: mode, splits: { ...splits }, ts: Date.now() });
    onClose();
  };

  return (
    <Modal onClose={onClose}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
        <div style={{ width: 44, height: 44, borderRadius: 13, background: "#dbeafe", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22 }}>🧾</div>
        <div style={{ fontWeight: 800, fontSize: 16, color: "#1e1e2e" }}>Thêm Khoản Chi</div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
        <Input placeholder="Mô tả" value={desc} onChange={(e: any) => setDesc(e.target.value)} />
        <Input placeholder="Số tiền" type="number" min="0" value={amount} onChange={(e: any) => setAmount(e.target.value)} />

        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6, display: "flex", justifyContent: "space-between" }}>
            <span>Người trả</span>
          </div>
          
          <div style={{ display: "flex", gap: 6, marginBottom: 10, overflowX: "auto", paddingBottom: 4 }}>
            <button 
              onClick={() => setPayers({ [members[0]]: amt })} 
              style={{ background: payers[members[0]] === amt ? "#7c3aed" : "#f1f5f9", color: payers[members[0]] === amt ? "#fff" : "#64748b", border: "none", borderRadius: 8, padding: "6px 12px", fontSize: 11, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" }}
            >
              🙋 Bạn trả hết
            </button>
            <button 
              onClick={() => {
                const share = amt / members.length;
                const p: any = {};
                members.forEach(m => p[m] = share);
                setPayers(p);
              }} 
              style={{ background: totalPaid === amt && Object.keys(payers).length > 1 ? "#7c3aed" : "#f1f5f9", color: totalPaid === amt && Object.keys(payers).length > 1 ? "#fff" : "#64748b", border: "none", borderRadius: 8, padding: "6px 12px", fontSize: 11, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" }}
            >
              🤝 Cả nhóm cùng trả
            </button>
          </div>

          <div style={{ background: "#f8fafc", borderRadius: 12, padding: "10px 12px" }}>
            {members.map((m, i) => {
              const isSelected = (payers[m] || 0) > 0;
              const isFull = Math.abs((payers[m] || 0) - amt) < 0.1 && amt > 0;
              return (
                <div key={i} onClick={() => setPayers({ [m]: amt })} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, cursor: "pointer", padding: "4px 8px", borderRadius: 10, background: isSelected ? "#fff" : "transparent", boxShadow: isSelected ? "0 2px 8px rgba(0,0,0,0.05)" : "none", transition: "all 0.2s" }}>
                  <Av name={m} size={30} ci={i} />
                  <span style={{ fontSize: 13, fontWeight: isSelected ? 700 : 600, color: isSelected ? "#1e293b" : "#64748b", flex: 1 }}>{m}</span>
                  {isSelected && (
                    <div style={{ background: isFull ? "#f0fdf4" : "#f1f5f9", color: isFull ? "#16a34a" : "#64748b", fontSize: 10, fontWeight: 800, padding: "3px 8px", borderRadius: 6 }}>
                      {isFull ? "ĐÃ TRẢ" : "GÓP TRẢ"}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>Kiểu chia</div>
          <div style={{ display:"flex", background: "#f1f5f9", borderRadius:10, padding:3, gap:2 }}>
            {[["equal", "⚖️ Đều"], ["percent", "📊 %"], ["adjust", "🔧 Adj"]].map(([v, l]) => (
              <button key={v} onClick={() => setMode(v)} style={{ flex: 1, padding: "7px 4px", border: "none", borderRadius: 8, background: mode === v ? "#7c3aed" : "transparent", color: mode === v ? "#fff" : "#64748b", fontWeight: 700, fontSize: 11, cursor: "pointer" }}>{l}</button>
            ))}
          </div>
        </div>

        {mode === "equal" && amt > 0 && (
          <div style={{ background: "#f0fdf4", borderRadius: 12, padding: "12px", border: "1.5px solid #bbf7d0" }}>
             <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: "#16a34a" }}>⚖️ Chia đều:</span>
                <span style={{ fontSize: 16, fontWeight: 800, color: "#16a34a" }}>{fmt(amt / members.length)} / người</span>
             </div>
             <div style={{ fontSize: 10, color: "#16a34a", marginTop: 4, opacity: 0.8 }}>Hệ thống tự động tính cho tất cả {members.length} thành viên</div>
          </div>
        )}

        {mode !== "equal" && (
          <div style={{ background: "#f8fafc", borderRadius: 12, padding: "10px 12px" }}>
            {mode === "percent" && (
              <>
                <div style={{ fontSize: 11, color: Math.abs(totalPct - 100) < 0.01 ? "#059669" : "#dc2626", fontWeight: 700, marginBottom: 8 }}>Tổng: {totalPct}%</div>
                {members.map((m, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <Av name={m} size={26} ci={i} /><span style={{ flex: 1, fontSize: 12, fontWeight: 600 }}>{m}</span>
                    <input type="number" value={splits[m] || ""} onChange={e => updateSplit(m, e.target.value)} placeholder="0" style={{ width: 60, border: "2px solid #e2e8f0", borderRadius: 8, padding: "5px 7px", fontSize: 13, outline: "none", textAlign: "right" }} />
                    <span style={{ fontSize: 11, color: "#94a3b8", minWidth: 60 }}>{fmt((splits[m] || 0) / 100 * amt)}</span>
                  </div>
                ))}
              </>
            )}
            {mode === "adjust" && (
              <>
                <div style={{ fontSize: 11, color: Math.abs(totalAdj) < 0.01 ? "#059669" : "#dc2626", fontWeight: 700, marginBottom: 8 }}>Bù: {fmt(totalAdj)}</div>
                {members.map((m, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <Av name={m} size={26} ci={i} /><span style={{ flex: 1, fontSize: 12, fontWeight: 600 }}>{m}</span>
                    <input type="number" value={splits[m] || ""} onChange={e => updateSplit(m, e.target.value)} placeholder="0" style={{ width: 80, border: "2px solid #e2e8f0", borderRadius: 8, padding: "5px 7px", fontSize: 13, outline: "none", textAlign: "right" }} />
                  </div>
                ))}
              </>
            )}
          </div>
        )}
        <Btn onClick={handleAdd} disabled={!valid} color="linear-gradient(135deg,#2563eb,#60a5fa)" style={{ width: "100%", marginTop: 4 }}>✅ Thêm khoản chi</Btn>
      </div>
    </Modal>
  );
}

function PayModal({ members, transactions, onPay, onClose }: { members: string[], transactions: any[], onPay: (p: Payment) => void, onClose: () => void }) {
  const [from,setFrom]=useState(transactions[0]?.from||members[0]||"");
  const [to,setTo]=useState(transactions[0]?.to||"");
  const [amount,setAmount]=useState(transactions[0]?Math.round(transactions[0].amount):"");
  const [note,setNote]=useState("");
  const suggested = transactions.find(t=>t.from===from&&t.to===to);
  const handlePay = () => {
    const amt=parseFloat(amount as string);
    if(!from||!to||from===to||isNaN(amt)||amt<=0) return;
    onPay({id: String(Date.now()), from,to,amount:amt,note:note.trim(),ts:Date.now()});
    onClose();
  };
  return (
    <Modal onClose={onClose}>
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16}}>
        <div style={{width:44,height:44,borderRadius:13,background:"#dcfce7",display:"flex",alignItems:"center",justifyContent:"center",fontSize:22}}>💸</div>
        <div style={{fontWeight:800,fontSize:16}}>Ghi Nhận Thanh Toán</div>
      </div>
      <div style={{marginBottom:10}}>
        <div style={{fontSize:11,fontWeight:700,color:"#64748b",textTransform:"uppercase",marginBottom:6}}>Người trả</div>
        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
          {members.map((m,i)=>(
            <button key={i} onClick={()=>{setFrom(m);const s=transactions.find(t=>t.from===m);if(s){setTo(s.to);setAmount(Math.round(s.amount).toString());}}} style={{display:"flex",alignItems:"center",gap:5,padding:"5px 10px 5px 5px",borderRadius:18,border:`2px solid ${from===m?"#7c3aed":"#e2e8f0"}`,background:from===m?"#f5f3ff":"#fff",cursor:"pointer"}}>
              <Av name={m} size={22} ci={i}/><span style={{fontSize:12,fontWeight:600,color:from===m?"#7c3aed":"#374151"}}>{m}</span>
            </button>
          ))}
        </div>
      </div>
      <div style={{marginBottom:10}}>
        <div style={{fontSize:11,fontWeight:700,color:"#64748b",textTransform:"uppercase",marginBottom:6}}>Người nhận</div>
        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
          {members.filter(m=>m!==from).map((m,i)=>(
            <button key={i} onClick={()=>{setTo(m);const s=transactions.find(t=>t.from===from&&t.to===m);if(s)setAmount(Math.round(s.amount).toString());}} style={{display:"flex",alignItems:"center",gap:5,padding:"5px 10px 5px 5px",borderRadius:18,border:`2px solid ${to===m?"#059669":"#e2e8f0"}`,background:to===m?"#f0fdf4":"#fff",cursor:"pointer"}}>
              <Av name={m} size={22} ci={members.indexOf(m)}/><span style={{fontSize:12,fontWeight:600,color:to===m?"#059669":"#374151"}}>{m}</span>
            </button>
          ))}
        </div>
      </div>
      {suggested&&<div style={{background:"#fff7ed",borderRadius:9,padding:"7px 11px",marginBottom:10,fontSize:12,color:"#d97706",display:"flex",alignItems:"center",gap:6}}>💡 <span><b>{from}</b> cần trả <b>{fmt(suggested.amount)}</b></span><button onClick={()=>setAmount(Math.round(suggested.amount).toString())} style={{marginLeft:"auto",background:"#d97706",color:"#fff",border:"none",borderRadius:6,padding:"3px 8px",fontSize:11,fontWeight:700,cursor:"pointer"}}>Dùng</button></div>}
      <Input placeholder="Số tiền" type="number" value={amount} onChange={(e: any)=>setAmount(e.target.value)} style={{marginBottom:8}}/>
      <Input placeholder="Ghi chú (tuỳ chọn)" value={note} onChange={(e: any)=>setNote(e.target.value)} style={{marginBottom:12}}/>
      <Btn onClick={handlePay} color="linear-gradient(135deg,#059669,#34d399)" style={{width:"100%"}}>✅ Xác nhận thanh toán</Btn>
    </Modal>
  );
}

function GroupSettingsModal({ group, friends, currentUser, onClose, onUpdate, onLeave, onDelete }: { group: Group, friends: Friend[], currentUser: string, onClose: () => void, onUpdate: (g: Group) => void, onLeave: () => void, onDelete: () => void }) {
  const [newName, setNewName] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const isLeader = group.leader === currentUser;
  const inviteCode = group.inviteCode;
  const [copied, setCopied] = useState(false);

  const copy = () => { navigator.clipboard.writeText(inviteCode); setCopied(true); setTimeout(() => setCopied(false), 2000); };
  
  const addM = () => {
    const name = newName.trim();
    if (!name || group.members.includes(name)) return;
    const newDetails = { ... (group.memberDetails || {}) };
    if (newPhone || newEmail) {
      newDetails[name] = { phone: newPhone, email: newEmail };
    }
    onUpdate({
      ...group,
      members: [...group.members, name],
      memberUids: [...group.memberUids, ""],
      memberDetails: newDetails
    });
    setNewName(""); setNewPhone(""); setNewEmail("");
  };

  const addFriendToGroup = (f: Friend) => {
    if (group.members.includes(f.name)) return;
    const newDetails = { ... (group.memberDetails || {}) };
    if (f.phone || f.email) {
      newDetails[f.name] = { phone: f.phone, email: f.email };
    }
    onUpdate({
      ...group,
      members: [...group.members, f.name],
      memberUids: [...group.memberUids, ""],
      memberDetails: newDetails
    });
  };

  return (
    <Modal onClose={onClose}>
      <div style={{fontWeight:800,fontSize:16,marginBottom:16,color:"#1e1e2e"}}>⚙️ Cài đặt nhóm</div>
      <Card style={{background:"#f5f3ff",marginBottom:10}}>
        <SecTitle icon="🔗" title="Mã mời" color="#7c3aed"/>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <div style={{flex:1,background:"#ede9fe",borderRadius:9,padding:"10px 14px",fontWeight:800,fontSize:18,color:"#7c3aed",letterSpacing:3,textAlign:"center"}}>{inviteCode}</div>
          <button onClick={copy} style={{background:copied?"#059669":"#7c3aed",color:"#fff",border:"none",borderRadius:9,padding:"10px 14px",fontWeight:700,fontSize:12,cursor:"pointer"}}>{copied?"✅ Đã sao chép":"📋 Sao chép"}</button>
        </div>
      </Card>
      <Card style={{marginBottom:10}}>
        <SecTitle icon="👥" title="Thành viên nhóm" color="#2563eb"/>
        <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:12}}>
          {group.members.map((m,i)=>(
            <div key={i} style={{display:"flex",alignItems:"center",gap:8,background:"#f8fafc",padding:"8px 10px",borderRadius:10}}>
              <Av name={m} size={28} ci={i}/>
              <span style={{flex:1,fontSize:13,fontWeight:600}}>{m}</span>
              {m !== group.leader && isLeader && (
                <div onClick={() => {
                   const f = friends.find(x => x.name === m);
                   const isLeaderNode = m === group.leader;
                   if (!isLeaderNode && isLeader) {
                     const newM = group.members.filter(x => x !== m);
                     const newUids = group.memberUids.filter((_, idx) => group.members[idx] !== m);
                     const newDetails = { ...group.memberDetails };
                     delete newDetails[m];
                     onUpdate({ ...group, members: newM, memberUids: newUids, memberDetails: newDetails });
                   }
                }} style={{ background: "none", border: "none", color: "#dc2626", fontSize: 18, cursor: "pointer" }}>×</div>
              )}
            </div>
          ))}
        </div>
        
        <div style={{ height: 1, background: "#f1f5f9", margin: "10px 0" }} />
        
        <div style={{ fontWeight: 700, fontSize: 12, color: "#64748b", marginBottom: 8 }}>CHỌN BẠN BÈ ĐÃ CÓ</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", maxHeight: 80, overflowY: "auto", background: "#f8fafc", padding: 8, borderRadius: 8, border: "1px solid #e2e8f0", marginBottom: 12 }}>
          {friends.filter(f => !group.members.includes(f.name)).map((f, i) => (
            <button key={i} onClick={() => addFriendToGroup(f)} style={{ display: "flex", alignItems: "center", gap: 5, padding: "4px 8px", borderRadius: 12, border: "1px solid #7c3aed", background: "#fff", cursor: "pointer", fontSize: 11, fontWeight: 600, color: "#7c3aed" }}>
              +{f.name}
            </button>
          ))}
          {friends.filter(f => !group.members.includes(f.name)).length === 0 && <div style={{ fontSize: 10, color: "#94a3b8" }}>Không có bạn mới để thêm.</div>}
        </div>

        <div style={{ fontWeight: 700, fontSize: 12, color: "#64748b", marginBottom: 8 }}>THÊM THÀNH VIÊN MỚI</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Input placeholder="Họ và tên" value={newName} onChange={(e: any) => setNewName(e.target.value)} style={{ fontSize: 13 }} />
          <div style={{ display: "flex", gap: 8 }}>
            <Input placeholder="Số điện thoại" value={newPhone} onChange={(e: any) => setNewPhone(e.target.value)} style={{ fontSize: 13, flex: 1 }} />
            <Input placeholder="Email" value={newEmail} onChange={(e: any) => setNewEmail(e.target.value)} style={{ fontSize: 13, flex: 1 }} />
          </div>
          <Btn onClick={addM} style={{ width: "100%", fontSize: 13 }}>✨ Thêm người này</Btn>
        </div>
      </Card>
      <div style={{display:"flex",flexDirection:"column",gap:8}}>
        <button onClick={onLeave} style={{background:"#fff7ed",color:"#d97706",border:"2px solid #fed7aa",borderRadius:11,padding:"11px",fontWeight:700,fontSize:13,cursor:"pointer"}}>👋 Rời nhóm</button>
        {isLeader&&<button onClick={onDelete} style={{background:"#fef2f2",color:"#dc2626",border:"2px solid #fecaca",borderRadius:11,padding:"11px",fontWeight:700,fontSize:13,cursor:"pointer"}}>🗑️ Xóa nhóm</button>}
      </div>
    </Modal>
  );
}

function GroupStats({ group, expenses, payments, balances }: { group: Group, expenses: Expense[], payments: Payment[], balances: Record<string, number>, transactions: any[] }) {
  const [chartView,setChartView]=useState("spend"); // spend | debt | compare
  const members=group.members;

  const spendData = members.map((m, i) => ({
    label: m,
    value: expenses.reduce((s: number, e: Expense) => s + (e.payers[m] || 0), 0),
    color: COLORS[i % COLORS.length]
  })).filter(d => d.value > 0);
  const debtData = members.map((m,i)=>({label:m,value:Math.abs(balances[m]||0),color:balances[m]>0?"#059669":"#dc2626"})).filter(d=>d.value>0);

  const totalSpend = expenses.reduce((s,e)=>s+e.amount,0);

  return (
    <Card>
      <SecTitle icon="📊" title="Thống kê" color="#2563eb"/>
      <div style={{display:"flex",background:"#f1f5f9",borderRadius:10,padding:3,gap:2,marginBottom:14}}>
        {[["spend","💰 Chi tiền"],["debt","⚖️ Số nợ"]].map(([v,l])=>(
          <button key={v} onClick={()=>setChartView(v)} style={{flex:1,padding:"7px 4px",border:"none",borderRadius:8,background:chartView===v?"#7c3aed":"transparent",color:chartView===v?"#fff":"#64748b",fontWeight:700,fontSize:11,cursor:"pointer"}}>{l}</button>
        ))}
      </div>

      {chartView==="spend" && (
        <>
          <div style={{display:"flex",alignItems:"center",gap:16,marginBottom:12}}>
            <PieChart data={spendData} size={110}/>
            <div style={{flex:1}}>
              {spendData.map((d,i)=>(
                <div key={i} style={{display:"flex",alignItems:"center",gap:6,marginBottom:5}}>
                  <div style={{width:10,height:10,borderRadius:"50%",background:d.color,flexShrink:0}}/>
                  <span style={{fontSize:12,fontWeight:600,flex:1,color:"#374151"}}>{d.label}</span>
                  <span style={{fontSize:11,fontWeight:700,color:d.color}}>{fmtShort(d.value)}</span>
                </div>
              ))}
            </div>
          </div>
          <div style={{textAlign:"center",fontSize:12,color:"#94a3b8",marginTop:8}}>Tổng: <b style={{color:"#7c3aed"}}>{fmt(totalSpend)}</b></div>
        </>
      )}

      {chartView==="debt" && (
        <>
          <div style={{display:"flex",alignItems:"center",gap:16,marginBottom:12}}>
            <PieChart data={debtData} size={110}/>
            <div style={{flex:1}}>
              {members.map((m,i)=>{
                const b=balances[m]||0;
                return (
                  <div key={i} style={{display:"flex",alignItems:"center",gap:6,marginBottom:5}}>
                    <Av name={m} size={20} ci={i}/>
                    <span style={{fontSize:12,fontWeight:600,flex:1}}>{m}</span>
                    <span style={{fontSize:11,fontWeight:700,color:b>0.01?"#059669":b<-0.01?"#dc2626":"#94a3b8"}}>{b>0.01?"+":""}{fmtShort(b)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </Card>
  );
}

function GroupView({ group, friends, onUpdate, onDelete, onLeave, onBack }: { group: Group, friends: Friend[], onUpdate: (g: Group) => void, onDelete: () => void, onLeave: () => void, onBack: () => void }) {
  const [subTab,setSubTab]=useState("home");
  const [selectedBill,setSelectedBill]=useState<Expense | null>(null);
  const [showAddExp,setShowAddExp]=useState(false);
  const [showPay,setShowPay]=useState(false);
  const [showSettings,setShowSettings]=useState(false);

  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [feed, setFeed] = useState<FeedItem[]>([]);

  const members  = group.members||[];

  useEffect(() => {
    if (!group.id) return;
    const unsubExp = onSnapshot(collection(db, "groups", group.id, "expenses"), snap => {
      setExpenses(snap.docs.map(d => ({ ...d.data(), id: d.id } as any)));
    }, err => handleFirestoreError(err, OperationType.LIST, `groups/${group.id}/expenses`));
    const unsubPay = onSnapshot(collection(db, "groups", group.id, "payments"), snap => {
      setPayments(snap.docs.map(d => ({ ...d.data(), id: d.id } as any)));
    }, err => handleFirestoreError(err, OperationType.LIST, `groups/${group.id}/payments`));
    const unsubFeed = onSnapshot(query(collection(db, "groups", group.id, "feed"), orderBy("ts", "desc")), snap => {
      setFeed(snap.docs.map(d => ({ ...d.data(), id: d.id } as any)));
    }, err => handleFirestoreError(err, OperationType.LIST, `groups/${group.id}/feed`));
    return () => { unsubExp(); unsubPay(); unsubFeed(); };
  }, [group.id]);

  const addExpense = async (exp: any) => {
    try {
      const mainPayer = Object.keys(exp.payers).find(k => (exp.payers[k] || 0) > 0) || "Ai đó";
      const { id, ...data } = exp;
      await addDoc(collection(db, "groups", group.id, "expenses"), { ...data, createdBy: auth.currentUser?.uid });
      await addDoc(collection(db, "groups", group.id, "feed"), {
        type: "expense",
        text: `${mainPayer} đã thêm "${exp.desc}" — ${fmt(exp.amount)}`,
        ts: Date.now(),
        icon: "🧾",
        name: mainPayer
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, "expenses");
    }
  };

  const removeExpense = async (id: string) => {
    try {
      await deleteDoc(doc(db, "groups", group.id, "expenses", id));
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `expenses/${id}`);
    }
  };

  const addPayment = async (p: any) => {
    try {
      const { id, ...data } = p;
      await addDoc(collection(db, "groups", group.id, "payments"), { ...data, createdBy: auth.currentUser?.uid });
      await addDoc(collection(db, "groups", group.id, "feed"), {
        type: "paid",
        text: `${p.from} đã trả ${fmt(p.amount)} cho ${p.to}${p.note?" · "+p.note:""}`,
        ts: p.ts,
        icon: "✅",
        name: p.from
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, "payments");
    }
  };

  const { total, balances, transactions } = useMemo(() => computeGroupBalances({ ...group, expenses, payments }), [group, expenses, payments]);

  const subtabs=[{id:"home",icon:"🏠"},{id:"expenses",icon:"🧾"},{id:"stats",icon:"📊"},{id:"members",icon:"👥"},{id:"feed",icon:"🔔"}];

  return (
    <div style={{display:"flex",flexDirection:"column",height:"100%"}}>
      {selectedBill&&<BillDetailModal bill={selectedBill} members={members} onClose={()=>setSelectedBill(null)}/>}
      {showAddExp&&<AddExpenseModal members={members} onAdd={addExpense} onClose={()=>setShowAddExp(false)}/>}
      {showPay&&<PayModal members={members} transactions={transactions} onPay={addPayment} onClose={()=>setShowPay(false)}/>}
      {showSettings&&<GroupSettingsModal group={group} friends={friends} currentUser={members[0]} onClose={()=>setShowSettings(false)} onUpdate={onUpdate} onLeave={onLeave} onDelete={onDelete}/>}

      <div style={{background:"linear-gradient(135deg,#7c3aed,#a78bfa)",padding:"12px 16px 0",flexShrink:0}}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
          <button onClick={onBack} style={{background:"rgba(255,255,255,0.2)", border:"none", borderRadius:8, width:32, height:32, color:"#fff", fontSize:24, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center"}}>‹</button>
          <div style={{fontSize:32}}>{group.emoji}</div>
          <div style={{flex:1}}>
            <div style={{color:"#fff",fontWeight:800,fontSize:17}}>{group.name}</div>
            <div style={{color:"#ddd6fe",fontSize:11}}>{members.length} thành viên · {fmt(total)}</div>
          </div>
          <button onClick={()=>setShowSettings(true)} style={{background:"rgba(255,255,255,.2)",border:"none",borderRadius:9,width:34,height:34,color:"#fff",fontSize:16,cursor:"pointer"}}>⚙️</button>
        </div>
        <div style={{display:"flex",gap:2}}>
          {subtabs.map(t=>(
            <button key={t.id} onClick={()=>setSubTab(t.id)} style={{flex:1,padding:"8px 4px",border:"none",background:"none",color:subTab===t.id?"#fff":"rgba(255,255,255,.6)",fontSize:18,cursor:"pointer",borderBottom:subTab===t.id?"2px solid #fff":"2px solid transparent"}}>{t.icon}</button>
          ))}
        </div>
      </div>

      <div style={{flex:1,overflowY:"auto",padding:"12px 14px 16px"}}>
        {subTab==="home"&&(
          <>
            <div style={{display:"flex",gap:8,marginBottom:10}}>
              <button onClick={()=>setShowAddExp(true)} style={{flex:1,background:"linear-gradient(135deg,#2563eb,#60a5fa)",color:"#fff",border:"none",borderRadius:12,padding:"11px",fontWeight:700,fontSize:13,cursor:"pointer"}}>🧾 Thêm khoản chi</button>
              <button onClick={()=>setShowPay(true)} style={{flex:1,background:"linear-gradient(135deg,#059669,#34d399)",color:"#fff",border:"none",borderRadius:12,padding:"11px",fontWeight:700,fontSize:13,cursor:"pointer"}}>💸 Thanh toán</button>
            </div>
            <Card style={{padding:"14px"}}>
              <SecTitle icon="🔄" title="Ai đang nợ ai?" color="#d97706"/>
              {transactions.length===0?(
                <div style={{textAlign:"center",padding:"12px 0",color:"#94a3b8",fontSize:13}}>{expenses.length===0?"Chưa có hóa đơn nào":"🎉 Mọi người đã huề!"}</div>
              ):transactions.map((t,i)=>(
                <div key={i} style={{display:"flex",alignItems:"center",gap:8,padding:"9px 0",borderBottom:i<transactions.length-1?"1px solid #f3f4f6":"none"}}>
                  <Av name={t.from} size={32} ci={members.indexOf(t.from)}/>
                  <div style={{flex:1,fontSize:12,fontWeight:600}}><span style={{color:"#dc2626"}}>{t.from}</span><span style={{color:"#94a3b8"}}> → </span><span style={{color:"#059669"}}>{t.to}</span></div>
                  <span style={{fontWeight:800,fontSize:14,color:"#7c3aed"}}>{fmt(t.amount)}</span>
                </div>
              ))}
            </Card>
          </>
        )}

        {subTab==="expenses"&&(
          <>
            {[...expenses].reverse().map((e)=>(
              <Card key={e.id} onClick={()=>setSelectedBill(e)} style={{padding:"12px 13px",marginBottom:8}}>
                <div style={{display:"flex",alignItems:"center",gap:9}}>
                  <div style={{width:38,height:38,borderRadius:11,background:"#ede9fe",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>🧾</div>
                  <div style={{flex:1}}>
                    <div style={{fontWeight:700,fontSize:13}}>{e.desc}</div>
                    <div style={{fontSize:11,color:"#7c3aed",fontWeight:600}}>
                      {Object.keys(e.payers).filter(k => (e.payers[k] || 0) > 0).join(", ")}
                    </div>
                  </div>
                  <div style={{textAlign:"right"}}><div style={{fontWeight:800,fontSize:13,color:"#db2777"}}>{fmt(e.amount)}</div></div>
                  <button onClick={ev=>{ev.stopPropagation();removeExpense(e.id);}} style={{background:"#fee2e2",border:"none",color:"#dc2626",borderRadius:7,width:24,height:24,cursor:"pointer",fontWeight:700,fontSize:11}}>×</button>
                </div>
              </Card>
            ))}
          </>
        )}

        {subTab==="stats"&&(
          <GroupStats group={group} expenses={expenses} payments={payments} balances={balances} transactions={transactions}/>
        )}

        {subTab==="members"&&(
          <div>
            <div style={{ background: "linear-gradient(135deg, #7c3aed 0%, #4c1d95 100%)", borderRadius: 20, padding: 24, color: "#fff", marginBottom: 20, boxShadow: "0 10px 25px -5px rgba(124, 58, 237, 0.3)" }}>
              <div style={{ fontSize: 40, marginBottom: 8 }}>👥</div>
              <div style={{ fontSize: 24, fontWeight: 900 }}>{members.length} Thành viên</div>
              <div style={{ fontSize: 13, opacity: 0.8, fontWeight: 500 }}>Những người đang cùng bạn chia sẻ mọi thứ</div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {members.map((m, i) => (
                <Card key={i} style={{ padding: "12px 14px", border: m === group.leader ? "1.5px solid #ddd6fe" : "none" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <Av name={m} size={42} ci={i} />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 800, fontSize: 15, color: "#1e293b", display: "flex", alignItems: "center", gap: 6 }}>
                        {m}
                        {m === group.leader && <span style={{ background: "#ede9fe", color: "#7c3aed", fontSize: 9, padding: "2px 6px", borderRadius: 10, fontWeight: 900 }}>TRƯỞNG NHÓM</span>}
                      </div>
                      {(group.memberDetails?.[m]?.phone || group.memberDetails?.[m]?.email) && (
                        <div style={{ fontSize: 10, color: "#94a3b8", display: "flex", gap: 8, marginTop: 2 }}>
                           {group.memberDetails[m].phone && <span>📞 {group.memberDetails[m].phone}</span>}
                           {group.memberDetails[m].email && <span>📧 {group.memberDetails[m].email}</span>}
                        </div>
                      )}
                      <div style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>
                        {(balances[m] || 0) >= 0 ? "🟢 Đang dư tiền" : "🔴 Đang nợ tiền"}
                      </div>
                    </div>
                    <div style={{ fontWeight: 800, fontSize: 14, color: (balances[m] || 0) >= 0 ? "#16a34a" : "#dc2626" }}>
                      {(balances[m] || 0) >= 0 ? "+" : ""}{fmt(balances[m] || 0)}
                    </div>
                  </div>
                </Card>
              ))}
            </div>

            <Card style={{ marginTop: 20, background: "#f8fafc", border: "1px dashed #cbd5e1", textAlign: "center", padding: "20px" }}>
              <div style={{ fontSize: 13, color: "#64748b", marginBottom: 12 }}>Muốn thêm người mới vào nhóm?</div>
              <Btn onClick={() => setShowSettings(true)} style={{ background: "#7c3aed", fontSize: 13 }}>
                ➕ Quản lý thành viên
              </Btn>
            </Card>
          </div>
        )}

        {subTab==="feed"&&(
          <div>
            {feed.map((item)=>(
              <div key={item.id} style={{display:"flex",gap:9,marginBottom:9}}>
                <div style={{flex:1,background:"#fff",borderRadius:11,padding:"8px 12px"}}>
                  <div style={{fontSize:12,color:"#1e1e2e"}}>{item.text}</div>
                  <div style={{fontSize:10,color:"#94a3b8"}}>{timeAgo(item.ts)}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function FriendActionModal({ friend, groups, onClose, onPay }: { friend: Friend, groups: Group[], onClose: () => void, onPay: (group: Group) => void }) {
  const [activeTab, setActiveTab] = useState("overview");

  const friendBalances = useMemo(() => {
    let sharedGroupsCount = 0;
    let netBalance = 0;
    const groupDetails: any[] = [];

    groups.forEach(g => {
      if (g.members.includes(friend.name)) {
        sharedGroupsCount++;
        const { balances } = computeGroupBalances(g);
        // We assume the user viewing the app is part of the group too (likely the leader or a member)
        // For simplicity, let's look at the balance of the friend.
        // If balance > 0, they paid more. If balance < 0, they owe.
        const bal = balances[friend.name] || 0;
        netBalance += bal;
        groupDetails.push({ name: g.name, emoji: g.emoji, balance: bal, group: g });
      }
    });
    return { sharedGroupsCount, netBalance, groupDetails };
  }, [friend, groups]);

  const sendReminder = () => {
    if (!friend.email) return;
    const subject = encodeURIComponent("Nhắc nhở thanh toán - HappyShare");
    const body = encodeURIComponent(`Chào ${friend.name},\n\nBạn đang có khoản nợ/dư là ${fmt(Math.abs(friendBalances.netBalance))} trong ứng dụng HappyShare.\n\nHãy kiểm tra và thanh toán nhé!\n\nTrân trọng.`);
    window.location.href = `mailto:${friend.email}?subject=${subject}&body=${body}`;
  };

  return (
    <Modal onClose={onClose}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
        <Av name={friend.name} size={54} ci={0} />
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 800, fontSize: 18 }}>{friend.name}</div>
          <div style={{ fontSize: 13, color: "#64748b" }}>{friendBalances.sharedGroupsCount} nhóm chung</div>
        </div>
      </div>

      <div style={{ background: friendBalances.netBalance >= 0 ? "#f0fdf4" : "#fef2f2", borderRadius: 16, padding: "16px", marginBottom: 20, textAlign: "center", border: `2px solid ${friendBalances.netBalance >= 0 ? "#bbf7d0" : "#fecaca"}` }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: friendBalances.netBalance >= 0 ? "#16a34a" : "#dc2626", textTransform: "uppercase", marginBottom: 4 }}>
          {friendBalances.netBalance >= 0 ? "Người này đang dư" : "Người này đang nợ"}
        </div>
        <div style={{ fontSize: 24, fontWeight: 900, color: friendBalances.netBalance >= 0 ? "#16a34a" : "#dc2626" }}>
          {fmt(Math.abs(friendBalances.netBalance))}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 20 }}>
        <Btn onClick={sendReminder} disabled={!friend.email} style={{ background: friend.email ? "#2563eb" : "#cbd5e1" }}>
          📧 {friend.email ? "Nhắc nợ" : "Không có mail"}
        </Btn>
        <Btn onClick={() => {
           const g = friendBalances.groupDetails[0]?.group;
           if(g) onPay(g);
        }} disabled={friendBalances.groupDetails.length === 0} color="#059669">
          💸 Thanh toán
        </Btn>
      </div>

      <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 10, color: "#1e293b" }}>Chi tiết từng nhóm:</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {friendBalances.groupDetails.map((gd, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, background: "#f8fafc", padding: "10px 12px", borderRadius: 12 }}>
            <span style={{ fontSize: 20 }}>{gd.emoji}</span>
            <span style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>{gd.name}</span>
            <span style={{ fontWeight: 800, fontSize: 13, color: gd.balance >= 0 ? "#16a34a" : "#dc2626" }}>
              {gd.balance >= 0 ? "+" : ""}{fmt(gd.balance)}
            </span>
          </div>
        ))}
        {friendBalances.groupDetails.length === 0 && <div style={{ textAlign: "center", color: "#94a3b8", fontSize: 12, padding: 10 }}>Không có nhóm chung nào.</div>}
      </div>
    </Modal>
  );
}

function FriendsView({ friends, groups, onAddFriend, onRemoveFriend, onPayClick }: { friends: Friend[], groups: Group[], onAddFriend: (f: Friend) => void, onRemoveFriend: (i: number) => void, onPayClick: (g: Group) => void }) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [selectedFriend, setSelectedFriend] = useState<Friend | null>(null);

  const add = () => {
    if (!name.trim()) return;
    onAddFriend({ name: name.trim(), phone: phone.trim(), email: email.trim() });
    setName("");
    setPhone("");
    setEmail("");
  };

  return (
    <div style={{ padding: "12px 14px" }}>
      {selectedFriend && <FriendActionModal friend={selectedFriend} groups={groups} onClose={() => setSelectedFriend(null)} onPay={(g) => { setSelectedFriend(null); onPayClick(g); }} />}
      
      <Card style={{ padding: "18px" }}>
        <SecTitle icon="👥" title="Thêm bạn mới" color="#7c3aed" />
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <Input placeholder="Họ và tên..." value={name} onChange={(e: any) => setName(e.target.value)} />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Input placeholder="Số điện thoại" value={phone} onChange={(e: any) => setPhone(e.target.value)} />
            <Input placeholder="Địa chỉ email" value={email} onChange={(e: any) => setEmail(e.target.value)} />
          </div>
          <Btn onClick={add} style={{ marginTop: 4, background: "linear-gradient(135deg,#7c3aed,#a78bfa)" }}>✨ Thêm bạn bè</Btn>
        </div>
      </Card>
      
      <div style={{ marginTop: 20, marginBottom: 12, fontSize: 13, fontWeight: 700, color: "rgba(255,255,255,0.9)", display: "flex", alignItems: "center", gap: 6 }}>
        <span>Danh sách bạn ({friends.length})</span>
        <div style={{ flex: 1, height: 1, background: "rgba(255,255,255,0.2)" }} />
      </div>

      {friends.map((f, i) => (
        <Card key={i} onClick={() => setSelectedFriend(f)} style={{ padding: "12px 14px", marginBottom: 7, cursor: "pointer" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <Av name={f.name} size={42} ci={i} />
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: 14 }}>{f.name}</div>
              <div style={{ fontSize: 11, color: "#94a3b8", display: "flex", flexWrap: "wrap", gap: "4px 8px" }}>
                {f.phone && <span>📞 {f.phone}</span>}
                {f.email && <span>✉️ {f.email}</span>}
              </div>
            </div>
            <button onClick={(e) => { e.stopPropagation(); onRemoveFriend(i); }} style={{ background: "#fef2f2", border: "none", color: "#dc2626", borderRadius: 8, width: 32, height: 32, cursor: "pointer", fontWeight: 700, fontSize: 16 }}>×</button>
          </div>
        </Card>
      ))}
      {friends.length === 0 && <div style={{ textAlign: "center", padding: "60px 20px", color: "rgba(255,255,255,0.6)", fontSize: 14 }}>Bạn chưa có người bạn nào.</div>}
    </div>
  );
}

function GroupsListView({ groups, friends, onSelectGroup, onCreateGroup }: { groups: Group[], friends: Friend[], onSelectGroup: (g: Group) => void, onCreateGroup: (g: Group) => void, onJoinGroup: () => void }) {
  const [showCreate,setShowCreate] = useState(false);
  const [showJoin,setShowJoin] = useState(false);
  const [gName,setGName] = useState(""); const [gEmoji,setGEmoji] = useState("🎉");
  const [selMembers,setSelMembers] = useState<string[]>([]);
  const [joinCode,setJoinCode] = useState("");

  const toggleMember = (m: string) => setSelMembers(s=>s.includes(m)?s.filter(x=>x!==m):[...s,m]);

  const canCreate = friends.length > 0;

  const createGroup = () => {
    if(!gName.trim() || !canCreate) return;
    onCreateGroup({id:String(Date.now()),name:gName.trim(),emoji:gEmoji,members:selMembers,memberUids:[],leader:selMembers[0]||"Trưởng nhóm",expenses:[],payments:[],feed:[{id:String(Date.now()),type:"group",text:`Nhóm "${gName.trim()}" được tạo`,ts:Date.now(),icon:"🎉"}],inviteCode:genCode(),dueDate:""});
    setGName("");setSelMembers([]);setShowCreate(false);
  };

  const joinGroup = () => {
    const g=groups.find(g=>g.inviteCode===joinCode.toUpperCase().trim());
    if(!g) return;
    setJoinCode("");setShowJoin(false);
    onSelectGroup(g);
  };

  return (
    <div style={{padding:"12px 14px"}}>
      {showCreate&&(
        <Modal onClose={()=>setShowCreate(false)}>
          <div style={{fontWeight:800,fontSize:16,marginBottom:14}}>🎉 Tạo nhóm mới</div>
          <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:10}}>
            {EMOJIS.map(e=><button key={e} onClick={()=>setGEmoji(e)} style={{width:38,height:38,borderRadius:9,fontSize:20,border:gEmoji===e?"2.5px solid #7c3aed":"2px solid #e2e8f0",background:gEmoji===e?"#f5f3ff":"#fff",cursor:"pointer"}}>{e}</button>)}
          </div>
          <Input placeholder="Tên nhóm..." value={gName} onChange={(e: any)=>setGName(e.target.value)} style={{marginBottom:10}}/>
          
          <div style={{fontWeight:700,fontSize:12,color:"#64748b",marginBottom:8}}>CHỌN THÀNH VIÊN ({selMembers.length})</div>
          <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:12,maxHeight:150,overflowY:"auto"}}>
            {friends.map((f,i)=>(
              <button key={i} onClick={()=>toggleMember(f.name)} style={{display:"flex",alignItems:"center",gap:5,padding:"5px 10px 5px 5px",borderRadius:18,border:`2px solid ${selMembers.includes(f.name)?"#7c3aed":"#e2e8f0"}`,background:selMembers.includes(f.name)?"#f5f3ff":"#fff",cursor:"pointer"}}>
                <Av name={f.name} size={22} ci={i}/><span style={{fontSize:12,fontWeight:600,color:selMembers.includes(f.name)?"#7c3aed":"#374151"}}>{f.name}</span>
              </button>
            ))}
            {friends.length === 0 && <div style={{fontSize:11,color:"#94a3b8"}}>Bạn chưa có bạn bè nào. Hãy thêm tên bên dưới.</div>}
          </div>

          <div style={{display:"flex",gap:6,marginBottom:12}}>
            <Input 
              placeholder="Thêm tên khác..." 
              id="new-member-input"
              onKeyDown={(e: any) => {
                if (e.key === "Enter") {
                  const val = e.target.value.trim();
                  if (val && !selMembers.includes(val)) {
                    setSelMembers([...selMembers, val]);
                    e.target.value = "";
                  }
                }
              }}
              style={{fontSize:12, flex:1}}
            />
            <button 
              onClick={() => {
                const input = document.getElementById("new-member-input") as HTMLInputElement;
                const val = input?.value.trim();
                if (val && !selMembers.includes(val)) {
                  setSelMembers([...selMembers, val]);
                  input.value = "";
                }
              }}
              style={{background:"#f1f5f9",border:"none",borderRadius:10,padding:"0 15px",fontWeight:700,fontSize:18,cursor:"pointer"}}
            >+</button>
          </div>

          <Btn onClick={createGroup} style={{width:"100%"}}>✨ Tạo nhóm</Btn>
        </Modal>
      )}
      {showJoin&&(
        <Modal onClose={()=>setShowJoin(false)}>
          <div style={{fontWeight:800,fontSize:16,marginBottom:14}}>🔗 Tham gia nhóm</div>
          <Input placeholder="Mã mời..." value={joinCode} onChange={(e: any)=>setJoinCode(e.target.value)} style={{marginBottom:8,textAlign:"center",letterSpacing:4}}/>
          <Btn onClick={joinGroup} style={{width:"100%"}}>Tham gia</Btn>
        </Modal>
      )}

      <div style={{display:"flex",gap:8,marginBottom:12}}>
        <button 
          onClick={()=>canCreate ? setShowCreate(true) : alert("Bạn cần có ít nhất 1 người bạn để tạo nhóm!")} 
          style={{flex:1,background:canCreate ? "linear-gradient(135deg,#7c3aed,#a78bfa)" : "#cbd5e1",color:"#fff",border:"none",borderRadius:12,padding:"11px",fontWeight:700,fontSize:13,cursor:canCreate ? "pointer" : "not-allowed"}}
        >
          ✨ Tạo nhóm
        </button>
        <button onClick={()=>setShowJoin(true)} style={{flex:1,background:"linear-gradient(135deg,#2563eb,#60a5fa)",color:"#fff",border:"none",borderRadius:12,padding:"11px",fontWeight:700,fontSize:13,cursor:"pointer"}}>🔗 Nhập mã mời</button>
      </div>

      {groups.map((g)=>{
        const total = (g.expenses || []).reduce((s,e)=>s+e.amount,0);
        const groupColorIndex = g.id.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
        return(
          <Card key={g.id} onClick={()=>onSelectGroup(g)} style={{padding:"14px 16px",marginBottom:10, transition: "transform 0.2s"}}>
            <div style={{display:"flex",alignItems:"center",gap:14}}>
              <div style={{width:52,height:52,borderRadius:16,background:COLORS[groupColorIndex % COLORS.length] + "15",display:"flex",alignItems:"center",justifyContent:"center",fontSize:30,flexShrink:0}}>
                {g.emoji}
              </div>
              <div style={{flex:1}}>
                <div style={{fontWeight:800,fontSize:15,color:"#1e293b",marginBottom:2}}>{g.name}</div>
                <div style={{fontSize:11,color:"#64748b",display:"flex",alignItems:"center",gap:5}}>
                  <span style={{background:"#f1f5f9",padding:"2px 6px",borderRadius:5,fontWeight:600}}>{g.members.length} người</span>
                </div>
              </div>
              <div style={{textAlign:"right",display:"flex",alignItems:"center",gap:8}}>
                <div style={{fontWeight:900,fontSize:16,color:"#7c3aed"}}>{fmtShort(total)}</div>
                <div style={{color:"#cbd5e1",fontSize:20,fontWeight:300}}>›</div>
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

interface UserPrefs {
  emailOnPayment: boolean;
  emailOnDebtReminder: boolean;
  emailOnAddedToGroup: boolean;
  emailOnAddedAsFriend: boolean;
  emailOnMonthlyReport: boolean;
}

const DEFAULT_PREFS: UserPrefs = {
  emailOnPayment: true,
  emailOnDebtReminder: true,
  emailOnAddedToGroup: true,
  emailOnAddedAsFriend: true,
  emailOnMonthlyReport: true
};

export default function App() {
  const [tab, setTab] = useState("groups");
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [userPrefs, setUserPrefs] = useState<UserPrefs>(DEFAULT_PREFS);
  const [groups, setGroups] = useState<Group[]>([]);
  const [friends, setFriends] = useState<Friend[]>([]);
  const [activeGroup, setActiveGroup] = useState<Group | null>(null);
  const [loading, setLoading] = useState(true);
  
  // Security & Profile state (Passcode might need to be in Firestore too, but let's keep it simple for now)
  const [passcode, setPasscode] = useState("");
  const [isLocked, setIsLocked] = useState(false);
  const [enteredPass, setEnteredPass] = useState("");
  const [profilePic, setProfilePic] = useState<string | null>(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      setUser(u);
      if (u) {
        // Ensure user document exists
        const userRef = doc(db, "users", u.uid);
        const userSnap = await getDoc(userRef);
        if (!userSnap.exists()) {
          await setDoc(userRef, {
            uid: u.uid,
            name: u.displayName || "User",
            email: u.email,
            photoURL: u.photoURL,
            createdAt: serverTimestamp(),
            prefs: DEFAULT_PREFS
          });
          setUserPrefs(DEFAULT_PREFS);
        } else {
          const data = userSnap.data();
          setUserPrefs(data.prefs || DEFAULT_PREFS);
        }
        setProfilePic(u.photoURL);
      }
      setLoading(false);
    });
    return unsub;
  }, []);

  const deleteAccount = async () => {
    if (!user) return;
    if (!window.confirm("BẠN CÓ CHẮC CHẮN MUỐN XÓA TÀI KHOẢN? \nHành động này không thể hoàn tác và tất cả dữ liệu cá nhân của bạn sẽ bị xóa.")) return;
    
    try {
      // 1. Delete friends
      const friendsSnap = await getDocs(collection(db, "users", user.uid, "friends"));
      for (const d of friendsSnap.docs) await deleteDoc(d.ref);
      
      // 2. Delete user doc
      await deleteDoc(doc(db, "users", user.uid));
      
      // 3. Delete auth user (might require recent login)
      await user.delete();
      alert("Tài khoản đã được xóa!");
    } catch (err: any) {
      if (err.code === 'auth/requires-recent-login') {
        alert("Vui lòng đăng nhập lại trước khi xóa tài khoản để bảo mật.");
        await logout();
      } else {
        handleFirestoreError(err, OperationType.DELETE, "account");
      }
    }
  };

  const updatePrefs = async (newPrefs: Partial<UserPrefs>) => {
    if (!user) return;
    const updated = { ...userPrefs, ...newPrefs };
    setUserPrefs(updated);
    try {
      await updateDoc(doc(db, "users", user.uid), { prefs: updated });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, "prefs");
    }
  };

  useEffect(() => {
    if (!user) {
      setGroups([]);
      setFriends([]);
      return;
    }

    // Sync friends
    const friendsRef = collection(db, "users", user.uid, "friends");
    const unsubFriends = onSnapshot(friendsRef, (snap) => {
      setFriends(snap.docs.map(d => d.data() as Friend));
    }, err => handleFirestoreError(err, OperationType.LIST, "friends"));

    // Sync groups where user is a member
    const groupsRef = collection(db, "groups");
    const groupsQuery = query(groupsRef, where("memberUids", "array-contains", user.uid));
    const unsubGroups = onSnapshot(groupsQuery, (snap) => {
      setGroups(snap.docs.map(d => ({ ...d.data(), id: d.id } as any)));
    }, err => handleFirestoreError(err, OperationType.LIST, "groups"));

    return () => {
      unsubFriends();
      unsubGroups();
    };
  }, [user]);

  const login = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, "login");
    }
  };

  const logout = () => signOut(auth);

  const updateGroup = async (g: any) => {
    if (!user) return;
    try {
      const { id, ...data } = g;
      await updateDoc(doc(db, "groups", id), data);
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `groups/${g.id}`);
    }
  };

  const deleteGroup = async (g: any) => {
    if (!user) return;
    try {
      await deleteDoc(doc(db, "groups", g.id));
      setActiveGroup(null);
      setTab("groups");
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `groups/${g.id}`);
    }
  };

  const leaveGroup = async (g: any) => {
    if (!user) return;
    try {
      const newUids = g.memberUids.filter((uid: string) => uid !== user.uid);
      const newNames = g.members.filter((name: string) => name !== (user.displayName || "Bạn"));
      await updateDoc(doc(db, "groups", g.id), { memberUids: newUids, members: newNames });
      setActiveGroup(null);
      setTab("groups");
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `groups/${g.id}`);
    }
  };

  const addFriend = async (f: Friend) => {
    if (!user) return;
    try {
      await addDoc(collection(db, "users", user.uid, "friends"), f);
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, "friends");
    }
  };

  const removeFriend = async (i: number) => {
    // This is a bit tricky with indexes. We should ideally have friend IDs.
    // For now, let's find the doc by name or just use the list.
    if (!user) return;
    const f = friends[i];
    const friendsRef = collection(db, "users", user.uid, "friends");
    const q = query(friendsRef, where("name", "==", f.name));
    const snap = await getDocs(q);
    snap.forEach(async (d) => await deleteDoc(d.ref));
  };

  const createGroup = async (g: any) => {
    if (!user) return;
    try {
      const groupData = {
        ...g,
        memberUids: [user.uid, ...selMemberUids(g.members)], // This needs logic to map names to UIDs if possible, or just user.uid
        createdBy: user.uid,
        createdAt: serverTimestamp()
      };
      delete groupData.expenses;
      delete groupData.payments;
      delete groupData.feed;
      delete groupData.id;

      // Ensure user is in memberUids
      if (!groupData.memberUids.includes(user.uid)) {
        groupData.memberUids.push(user.uid);
      }
      if (!groupData.members.includes(user.displayName || "Bạn")) {
        groupData.members.push(user.displayName || "Bạn");
      }

      const docRef = await addDoc(collection(db, "groups"), groupData);
      
      // Add initial feed
      await addDoc(collection(db, "groups", docRef.id, "feed"), {
        type: "group",
        text: `Nhóm "${g.name}" được tạo`,
        ts: Date.now(),
        icon: "🎉"
      });

      setTab("active");
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, "groups");
    }
  };

  // Helper to map friend names to UIDs if we have them (this is complex without a global user search)
  // For now, we'll just store names and only the current user's UID for security checks.
  const selMemberUids = (names: string[]) => {
    return [user?.uid].filter(Boolean) as string[];
  };

  const selectGroup = (g: Group) => { setActiveGroup(g); setTab("active"); };

  const tabs=[
    {id:"groups",icon:"🏠",label:"Nhóm"},
    {id:"friends",icon:"👥",label:"Bạn bè"},
    {id:"settings",icon:"⚙️",label:"Cài đặt"},
  ];

  const handlePicUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const url = URL.createObjectURL(file);
      setProfilePic(url);
    }
  };

  const unlock = () => {
    if (enteredPass === passcode) {
      setIsLocked(false);
      setEnteredPass("");
    } else {
      alert("Sai mật khẩu!");
    }
  };

  if (loading) {
    return (
      <div style={{minHeight:"100vh", display:"flex", alignItems:"center", justifyContent:"center", background:"#4c1d95", color:"#fff"}}>
         <div style={{fontSize: 24, fontWeight: 700}}>Đang tải...</div>
      </div>
    );
  }

  if (!user) {
    return (
      <div style={{minHeight:"100vh", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", background:"linear-gradient(135deg,#4c1d95 0%,#7c3aed 40%,#a78bfa 100%)", color:"#fff", padding:20, textAlign: "center"}}>
        <div style={{fontSize:80, marginBottom:20}}>✨</div>
        <h1 style={{fontSize: 32, fontWeight: 900, marginBottom: 10}}>Chào mừng đến với HappyShare</h1>
        <p style={{fontSize: 14, color: "rgba(255,255,255,0.8)", marginBottom: 30, maxWidth: 300}}>
          Ứng dụng chia sẻ hóa đơn thông minh và minh bạch. Đăng nhập để bắt đầu!
        </p>
        <Btn onClick={login} style={{width: 260, fontSize: 16, padding: "14px 20px"}}>
          🚀 Đăng nhập bằng Google
        </Btn>
      </div>
    );
  }

  if (isLocked && passcode) {
    return (
      <div style={{minHeight:"100vh", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", background:"#4c1d95", color:"#fff", padding:20}}>
        <div style={{fontSize:48, marginBottom:20}}>🔒</div>
        <h2 style={{marginBottom:20}}>HappyShare Locked</h2>
        <Input 
          type="password" 
          placeholder="Nhập mã bảo mật..." 
          value={enteredPass} 
          onChange={(e: any) => setEnteredPass(e.target.value)}
          onKeyDown={(e: any) => e.key === "Enter" && unlock()}
          style={{maxWidth:300, textAlign:"center", fontSize:18, letterSpacing:4, color: "#1e1e2e"}}
        />
        <Btn onClick={unlock} style={{marginTop:20, width:300}}>Mở khóa</Btn>
      </div>
    );
  }

  return (
    <div style={{minHeight:"100vh",display:"flex",flexDirection:"column",background:"linear-gradient(135deg,#4c1d95 0%,#7c3aed 40%,#a78bfa 100%)",fontFamily:"system-ui"}}>
      {/* HEADER */}
      <div style={{padding:"20px 20px 15px", background: "rgba(0,0,0,0.15)", borderBottom: "1px solid rgba(255,255,255,0.1)", display: "flex", alignItems: "center", justifyContent: "space-between"}}>
        <div 
          onClick={() => setTab("settings")}
          style={{cursor: "pointer", transition: "transform 0.2s", ":hover": {transform: "scale(1.05)"}} as any}
        >
          {profilePic ? (
            <img src={profilePic} style={{width: 40, height: 40, borderRadius: "50%", objectFit: "cover", border: "2px solid #fff"}} />
          ) : (
            <div style={{width: 40, height: 40, borderRadius: "50%", background: "#7c3aed", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 800, fontSize: 14, border: "2px solid #fff"}}>ME</div>
          )}
        </div>
        <div style={{textAlign: "center"}}>
          <h1 style={{color:"#fff", fontSize:22, fontWeight:900, letterSpacing:-0.5, margin:0}}>✨ HappyShare</h1>
          <p style={{color:"rgba(255,255,255,0.8)", fontSize:11, margin:"2px 0 0"}}>Dividing Joy, Not Just Bills</p>
        </div>
        <div style={{width: 40}} /> {/* Spacer for balance */}
      </div>

      <div style={{flex:1,overflowY:"auto",paddingBottom:70}}>
        {tab==="groups"&&<GroupsListView groups={groups} friends={friends} onSelectGroup={selectGroup} onCreateGroup={createGroup} onJoinGroup={()=>{}}/>}
        {tab==="active"&&activeGroup&&(
          <GroupView group={groups.find(g=>g.id===activeGroup.id)||activeGroup} friends={friends} onUpdate={updateGroup} onDelete={()=>deleteGroup(activeGroup)} onLeave={()=>leaveGroup(activeGroup)} onBack={() => setTab("groups")}/>
        )}
        {tab==="friends"&&<FriendsView friends={friends} groups={groups} onAddFriend={addFriend} onRemoveFriend={removeFriend} onPayClick={(g) => selectGroup(g)}/>}
        {tab==="settings" && (
          <div style={{padding:14}}>
            {/* Account Settings */}
            <Card>
              <SecTitle icon="👤" title="Tài khoản" color="#7c3aed"/>
              <div style={{display:"flex", alignItems:"center", gap:15, marginBottom:15}}>
                {profilePic ? (
                  <img src={profilePic} style={{width:64, height:64, borderRadius:"50%", objectFit:"cover", border:"3px solid #7c3aed"}} />
                ) : (
                  <div style={{width:64, height:64, borderRadius:"50%", background:"#ede9fe", display:"flex", alignItems:"center", justifyContent:"center", fontSize:24, border:"2px dashed #7c3aed"}}>📷</div>
                )}
                <div style={{flex:1}}>
                  <div style={{fontWeight:700, fontSize:15, marginBottom:4}}>Ảnh đại diện</div>
                  <input type="file" id="pfp-upload" hidden accept="image/*" onChange={handlePicUpload} />
                  <label htmlFor="pfp-upload" style={{display:"inline-block", background:"#7c3aed", color:"#fff", padding:"6px 12px", borderRadius:8, fontSize:12, fontWeight:600, cursor:"pointer"}}>Đổi ảnh</label>
                </div>
              </div>
            </Card>

            {/* Sở thích & Thông báo */}
            <Card>
               <SecTitle icon="⚙️" title="Sở thích & Thông báo" color="#7c3aed"/>
               
               <div style={{marginBottom:20}}>
                 <div style={{fontSize:12, fontWeight:700, color:"#64748b", textTransform:"uppercase", letterSpacing:1, marginBottom:10}}>Bảo mật</div>
                 <div style={{display:"flex", alignItems:"center", justifyContent:"space-between", background:"#f8fafc", padding:"12px 14px", borderRadius:12}}>
                    <div style={{flex:1}}>
                       <div style={{fontSize:14, fontWeight:700, color:"#1e293b"}}>Khóa ứng dụng</div>
                       <div style={{fontSize:11, color:"#64748b"}}>Yêu cầu Passcode khi mở ứng dụng</div>
                    </div>
                    <Input 
                      placeholder="Mã số..." 
                      type="password" 
                      value={passcode} 
                      onChange={(e:any)=>setPasscode(e.target.value)} 
                      style={{width:100, textAlign:"center", marginBottom:0, padding: "8px"}}
                    />
                 </div>
                 {passcode && (
                   <Btn onClick={() => setIsLocked(true)} color="#ef4444" style={{width:"100%", marginTop: 10, fontSize: 12}}>Khóa ngay bây giờ</Btn>
                 )}
               </div>

               <div>
                 <div style={{fontSize:12, fontWeight:700, color:"#64748b", textTransform:"uppercase", letterSpacing:1, marginBottom:10}}>Thông báo Email</div>
                 {[
                   { id: "emailOnPayment", label: "Có người trả tiền", desc: "Nhận mail khi có thành viên thanh toán trong nhóm" },
                   { id: "emailOnDebtReminder", label: "Nhắc nợ", desc: "Nhận mail khi có người yêu cầu bạn trả tiền" },
                   { id: "emailOnAddedToGroup", label: "Được thêm vào nhóm", desc: "Nhận mail khi bạn trở thành thành viên nhóm mới" },
                   { id: "emailOnAddedAsFriend", label: "Kết bạn mới", desc: "Nhận mail khi ai đó lưu bạn vào danh sách bạn" },
                   { id: "emailOnMonthlyReport", label: "Báo cáo tháng", desc: "Bản tin tổng hợp chi tiêu cuối mỗi tháng" }
                 ].map((item) => (
                   <div key={item.id} style={{display:"flex", alignItems:"center", justifyContent:"space-between", padding:"10px 0", borderBottom:"1px solid #f1f5f9"}}>
                      <div style={{flex:1, marginRight:12}}>
                         <div style={{fontSize:14, fontWeight:600, color:"#334155"}}>{item.label}</div>
                         <div style={{fontSize:10, color:"#94a3b8"}}>{item.desc}</div>
                      </div>
                      <div 
                        onClick={() => updatePrefs({ [item.id]: !((userPrefs as any)[item.id]) })}
                        style={{
                          width: 44, height: 24, borderRadius: 12, background: (userPrefs as any)[item.id] ? "#7c3aed" : "#e2e8f0",
                          position: "relative", cursor: "pointer", transition: "0.2s"
                        }}
                      >
                         <div style={{
                           width: 18, height: 18, borderRadius: "50%", background: "#fff",
                           position: "absolute", top: 3, left: (userPrefs as any)[item.id] ? 23 : 3,
                           transition: "0.2s", boxShadow: "0 2px 4px rgba(0,0,0,0.1)"
                         }}/>
                      </div>
                   </div>
                 ))}
               </div>
            </Card>

            {/* Hệ thống */}
            <Card>
               <SecTitle icon="🚪" title="Hệ thống" color="#374151"/>
               <div style={{display:"flex", gap:8}}>
                 <Btn onClick={logout} color="#374151" style={{flex:1, fontSize:12, padding:"10px"}}>Đăng xuất</Btn>
                 <button 
                   onClick={deleteAccount}
                   style={{
                     flex:1, padding:"10px", borderRadius:12, border:"1px solid #fee2e2", 
                     background:"#fff", color:"#ef4444", fontSize:11, fontWeight:700, cursor:"pointer"
                   }}
                 >
                   🗑️ Xóa TK
                 </button>
               </div>
            </Card>
          </div>
        )}
      </div>

      <div style={{position:"fixed",bottom:12,left:12,right:12,background:"rgba(255,255,255,0.9)", backdropFilter:"blur(10px)",borderRadius:20,display:"flex",padding:"8px 4px",boxShadow:"0 8px 32px rgba(124,58,237,0.15)",zIndex:1000, border:"1px solid rgba(255,255,255,0.5)"}}>
        {tabs.map(t=>(
          <button key={t.id} onClick={()=>setTab(t.id)} style={{flex:1,padding:"4px 0",border:"none",background:"none",cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",gap:2, position:"relative"}}>
            <div style={{fontSize:18,color:(tab===t.id || (t.id==="groups" && tab==="active"))?"#7c3aed":"#94a3b8", transform: (tab===t.id || (t.id==="groups" && tab==="active")) ? "translateY(-1px)" : "none", transition: "0.2s"}}>{t.icon}</div>
            <span style={{fontSize:9,color:(tab===t.id || (t.id==="groups" && tab==="active"))?"#7c3aed":"#94a3b8", fontWeight:700, letterSpacing:0.3, opacity: (tab===t.id || (t.id==="groups" && tab==="active")) ? 1 : 0.6}}>{t.label}</span>
            {(tab===t.id || (t.id==="groups" && tab==="active")) && <div style={{position:"absolute", bottom:-2, width:4, height:4, borderRadius:"50%", background:"#7c3aed"}} />}
          </button>
        ))}
      </div>
    </div>
  );
}
