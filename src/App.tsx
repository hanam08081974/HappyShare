import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, ReferenceLine, AreaChart, Area } from "recharts";
import React, { useState, useMemo, useEffect, useRef } from "react";
import { QrCode, Receipt, Upload, Loader2, ImagePlus, Camera, LogOut } from "lucide-react";
import { initializeApp } from "firebase/app";
import { getAuth, onAuthStateChanged, signInWithPopup, GoogleAuthProvider, signOut, User as FirebaseUser, reauthenticateWithPopup } from "firebase/auth";
import { getFirestore, initializeFirestore, collection, doc, setDoc, getDoc, getDocs, onSnapshot, query, where, addDoc, updateDoc, deleteDoc, serverTimestamp, getDocFromServer, orderBy, collectionGroup } from "firebase/firestore";
import { GoogleGenAI, Type } from "@google/genai";
import firebaseConfig from "../firebase-applet-config.json";
import QRCode from "react-qr-code";

// Initialize AI
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Initialize Firebase
const app = initializeApp(firebaseConfig);
export const db = initializeFirestore(app, {
  experimentalForceLongPolling: true,
}, firebaseConfig.firestoreDatabaseId);

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
  
  let msg = "Lỗi hệ thống!";
  if (errInfo.error.includes("permission-denied") || errInfo.error.includes("insufficient permissions")) {
    msg = "Bạn không có quyền thực hiện thao tác này.";
  } else if (errInfo.error.includes("quota-exceeded")) {
    msg = "Hết hạn mức sử dụng miễn phí (Quota exceeded). Thử lại vào ngày mai.";
  }
  alert(msg + "\nChi tiết: " + errInfo.operationType + " " + (errInfo.path || ""));
  
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

// ─── Constants ───────────────────────────────────────────────
const COLORS = ["#059669","#2563EB","#DB2777","#D97706","#059669","#DC2626","#0891B2","#059669","#EA580C","#0D9488"];
const EMOJIS = ["🏖️","🍜","🎉","✈️","🏠","🎮","🛒","🍻","🏕️","💼"];
const fmt = (n: number, symbol: string = "đ") => {
  const rounded = Math.round(n);
  const formatted = new Intl.NumberFormat("vi-VN").format(Object.is(rounded, -0) ? 0 : rounded);
  return `${formatted} ${symbol}`;
};
const fmtShort = (n: number, symbol: string = "đ") => { 
  const val = Math.round(n);
  const abs = Math.abs(val);
  if (abs >= 1e6) return (val / 1e6).toFixed(1) + "tr"; 
  if (abs >= 1e3) return (val / 1e3).toFixed(0) + "k"; 
  return (Object.is(val, -0) ? 0 : val) + " " + symbol; 
};
const timeAgo = (ts: number) => { const s=Math.floor((Date.now()-ts)/1000); if(s<60)return"vừa xong"; if(s<3600)return`${Math.floor(s/60)}p trước`; if(s<86400)return`${Math.floor(s/3600)}h trước`; return`${Math.floor(s/86400)}d trước`; };
const genCode = () => Math.random().toString(36).slice(2,8).toUpperCase();
// Numeric formatting helpers
const formatNum = (v: string | number) => {
  if (v === "" || v === undefined) return "";
  const n = typeof v === "string" ? v.replace(/\D/g, "") : Math.round(v).toString();
  if (!n) return "";
  return new Intl.NumberFormat("vi-VN").format(parseInt(n));
};
const parseNum = (v: string) => {
  const digits = v.replace(/\D/g, "");
  return digits ? parseInt(digits) : 0;
};
const parseNumStr = (v: string) => {
  const digits = v.replace(/\D/g, "");
  return digits || "";
};

// ─── Types ───────────────────────────────────────────────────
interface Friend {
  id?: string;
  name: string;
  email: string;
  avatar?: string;
  status: 'pending' | 'accepted';
  createdAt: number;
}

// Helper to clean undefined fields for Firestore
const clean = (obj: any) => {
  const newObj = { ...obj };
  Object.keys(newObj).forEach(key => {
    if (newObj[key] === undefined) {
      delete newObj[key];
    }
  });
  return newObj;
};

interface ReceiptItem {
  name: string;
  price: number;
  assignedTo: string[]; // member names
}

interface Expense {
  id: string;
  desc: string;
  amount: number;
  payers: Record<string, number>; // Multiple payers: { name: amount }
  splitMode: string; // "equal" | "percent" | "adjust" | "itemized"
  splits: Record<string, number>;
  participants?: string[]; // New: list of member names who benefit from this expense
  attachment?: string; // New: optional image attachment
  ts: number;
  category?: string;
  items?: ReceiptItem[]; // For itemized mode
  memberDetails?: Record<string, { phone?: string; email?: string; avatar?: string }>;
}

// ─── Utilities ──────────────────────────────────────────────
const getExpenseSplits = (exp: Expense, group: Group): Record<string, number> => {
  const members = group.members;
  const res: Record<string, number> = {};
  const totalAmount = Math.round(exp.amount);
  let distributed = 0;
  
  // Use specific participants if provided, otherwise deduce from memberDetails, fallback to members joined before expense
  const activeMembers = exp.participants && exp.participants.length > 0 ? exp.participants : (exp.memberDetails && Object.keys(exp.memberDetails).length > 0 ? Object.keys(exp.memberDetails) : members.filter(m => !(group.memberJoinedAt?.[m]) || group.memberJoinedAt[m] <= exp.ts + 300000));

  members.forEach(m => res[m] = 0);
  activeMembers.forEach(m => res[m] = 0);

  if (exp.splitMode === "equal") {
    const base = Math.floor(totalAmount / activeMembers.length);
    const rem = totalAmount % activeMembers.length;
    // Distribute among active members
    activeMembers.forEach((m, i) => {
      res[m] = base + (i < rem ? 1 : 0);
    });
  } else if (exp.splitMode === "percent") {
    activeMembers.forEach((m, i) => {
      if (i === activeMembers.length - 1) {
        res[m] = totalAmount - distributed;
      } else {
        res[m] = Math.round((exp.splits[m] || 0) / 100 * totalAmount);
        distributed += res[m];
      }
    });
  } else if (exp.splitMode === "adjust") {
    const totalAdj = activeMembers.reduce((s, m) => s + Math.round(exp.splits[m] || 0), 0);
    const amountToSplit = totalAmount - totalAdj;
    const base = Math.floor(amountToSplit / activeMembers.length);
    const rem = amountToSplit % activeMembers.length;
    activeMembers.forEach((m, i) => {
      res[m] = base + (i < rem ? 1 : 0) + Math.round(exp.splits[m] || 0);
    });
  } else if (exp.splitMode === "itemized") {
    exp.items?.forEach(item => {
      const p = Math.round(item.price || 0);
      const targets = item.assignedTo?.length ? item.assignedTo : activeMembers;
      const base = Math.floor(p / targets.length);
      const rem = p % targets.length;
      targets.forEach((m, i) => {
        res[m] = (res[m] || 0) + base + (i < rem ? 1 : 0);
      });
    });
    const allocated = exp.items?.reduce((s, it) => s + Math.round(it.price || 0), 0) || 0;
    const remaining = totalAmount - allocated;
    if (remaining !== 0) {
      const base = Math.floor(remaining / activeMembers.length);
      const rem = remaining % activeMembers.length;
      activeMembers.forEach((m, i) => {
        res[m] = (res[m] || 0) + base + (i < rem ? 1 : 0);
      });
    }
  }
  return res;
};

const computeGroupBalances = (group: Group) => {
  const members = group.members;
  const expenses = group.expenses || [];
  const payments = group.payments || [];
  
  if (!members.length) return { total: 0, balances: {}, transactions: [] };
  
  const total = expenses.reduce((s, e) => s + Math.round(e.amount), 0);
  const adj: Record<string, number> = {};
  members.forEach(m => adj[m] = 0);

  expenses.forEach(e => {
    const splits = getExpenseSplits(e, group);
    // Add amounts paid by this member
    Object.entries(e.payers).forEach(([name, amt]) => {
      if (adj[name] !== undefined) adj[name] += Math.round(amt as number);
    });
    // Subtract amounts owed by this member
    members.forEach(m => {
      adj[m] -= (splits[m] || 0);
    });
  });

  payments.forEach(p => {
    const amt = Math.round(p.amount);
    if (adj[p.from] !== undefined) adj[p.from] += amt;
    if (adj[p.to] !== undefined) adj[p.to] -= amt;
  });

  const c = members.filter(m => adj[m] >= 1).map(m => ({ name: m, amt: adj[m] })).sort((a, b) => b.amt - a.amt);
  const d = members.filter(m => adj[m] <= -1).map(m => ({ name: m, amt: -adj[m] })).sort((a, b) => b.amt - a.amt);
  const txns: any[] = [];
  let ci = 0, di = 0;
  while (ci < c.length && di < d.length) {
    const s = Math.min(c[ci].amt, d[di].amt);
    txns.push({ from: d[di].name, to: c[ci].name, amount: s });
    c[ci].amt -= s;
    if (c[ci].amt < 1) ci++;
    d[di].amt -= s;
    if (d[di].amt < 1) di++;
  }

  return { total, balances: adj, transactions: txns.filter(t => t.amount >= 1) };
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
  memberDetails?: Record<string, { phone?: string; email?: string; avatar?: string }>;
  leader: string;
  leaderUid: string;
  expenses?: Expense[];
  payments?: Payment[];
  feed?: FeedItem[];
  inviteCode: string;
  dueDate: string;
  memberJoinedAt?: Record<string, number>;
}

// ─── Tiny Components ─────────────────────────────────────────
function Av({ name, size=36, ci=0, avatar, style={} }: { name: string, size?: number, ci?: number, avatar?: string, style?: any }) {
  if (avatar) {
    if (avatar.startsWith("http") || avatar.startsWith("data:")) {
      return <img src={avatar} style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover", flexShrink: 0, ...style }} alt={name} />;
    }
    return <div style={{width:size,height:size,borderRadius:"50%",background:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:size*0.6,flexShrink:0,boxShadow:"0 2px 8px rgba(0,0,0,0.05)",...style}}>{avatar}</div>;
  }
  const ini = name.trim().split(" ").map(w=>w[0]).join("").toUpperCase().slice(0,2);
  const hash = name.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return <div style={{width:size,height:size,borderRadius:"50%",background:COLORS[hash%COLORS.length],display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontWeight:700,fontSize:size*.38,flexShrink:0,...style}}>{ini||"?"}</div>;
}
function Card({ children, style={}, onClick }: { children: React.ReactNode, style?: any, onClick?: () => void, key?: any }) {
  return <div onClick={onClick} style={{background:"#fff",borderRadius:16,boxShadow:"0 4px 24px rgba(11,86,94,.12)",padding:"16px",marginBottom:10,...style,cursor:onClick?"pointer":"default"}}>{children}</div>;
}
function SecTitle({ icon, title, color, right, textColor="#0b565e" }: { icon: string, title: string, color: string, right?: React.ReactNode, textColor?: string }) {
  return <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:12}}><div style={{width:30,height:30,borderRadius:9,background:color+"20",display:"flex",alignItems:"center",justifyContent:"center",fontSize:15}}>{icon}</div><span style={{fontWeight:700,fontSize:14,color:textColor,flex:1}}>{title}</span>{right}</div>;
}
function Btn({ children, onClick, color="#059669", disabled=false, style={} }: { children: React.ReactNode, onClick: () => void, color?: string, disabled?: boolean, style?: any }) {
  return <button onClick={onClick} disabled={disabled} style={{background:disabled?"#e2e8f0":color,color:disabled?"#94a3b8":"#fff",border:"none",borderRadius:11,padding:"11px 16px",fontWeight:700,fontSize:13,cursor:disabled?"not-allowed":"pointer",...style}}>{children}</button>;
}
function Input({ style={}, ...p }: any) {
  return <input {...p} style={{border:"2px solid #ede9fe",borderRadius:10,padding:"9px 11px",fontSize:13,outline:"none",width:"100%",boxSizing:"border-box",...style}}/>;
}

// ─── Join Group Modal ──────────────────────────────────────────
function JoinGroupModal({ group, profile, onClose, onJoined }: { group: Group, profile: UserProfile | null, onClose: () => void, onJoined: (g: Group) => void }) {
  const [joining, setJoining] = useState(false);

  const handleJoin = async () => {
    if (!profile || joining) return;
    setJoining(true);
    try {
      if (group.memberUids.includes(profile.uid)) {
        onJoined(group);
        return;
      }
      
      const newMembers = [...group.members, profile.name];
      const newUids = [...group.memberUids, profile.uid];
      const newDetails = { ...(group.memberDetails || {}) };
      newDetails[profile.name] = { avatar: profile.avatar };
      
      await updateDoc(doc(db, "groups", group.id), {
        members: newMembers,
        memberUids: newUids,
        memberDetails: newDetails,
        updatedAt: serverTimestamp()
      });

      onJoined({ ...group, members: newMembers, memberUids: newUids, memberDetails: newDetails });
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, "joining group");
    } finally {
      setJoining(false);
    }
  };

  return (
    <Modal onClose={onClose}>
      <div style={{ textAlign: "center", padding: "10px 0 20px" }}>
        <div style={{ fontSize: 50, marginBottom: 10 }}>{group.emoji}</div>
        <div style={{ fontSize: 20, fontWeight: 800, color: "#0b565e", marginBottom: 6 }}>{group.name}</div>
        <div style={{ fontSize: 13, color: "#2d666d", marginBottom: 20 }}>Mời bạn tham gia nhóm chi tiêu chung.</div>
        <Btn onClick={handleJoin} disabled={joining} style={{ width: "100%", padding: 14 }}>
          {joining ? "Đang xử lý..." : "Tham gia ngay 🚀"}
        </Btn>
      </div>
    </Modal>
  );
}

// ─── Modals ───────────────────────────────────────────────────
function Modal({ children, onClose }: { children: React.ReactNode, onClose: () => void }) {
  return (
    <div onClick={onClose} style={{position:"fixed",inset:0,background:"rgba(76,29,149,.55)",display:"flex",alignItems:"flex-end",justifyContent:"center",zIndex:1100,backdropFilter:"blur(4px)"}}>
      <div onClick={e=>e.stopPropagation()} style={{background:"#fff",borderRadius:"22px 22px 0 0",padding:"22px 18px 36px",width:"100%",maxWidth:520,boxShadow:"0 -8px 40px rgba(124,58,237,.2)",maxHeight:"88vh",overflowY:"auto"}}>
        <div style={{width:38,height:4,background:"#e2e8f0",borderRadius:4,margin:"0 auto 18px"}}/>
        {children}
      </div>
    </div>
  );
}

function BillDetailModal({ bill, group, memberAvatars, onClose, currency = "đ" }: { bill: Expense, group: Group, memberAvatars?: Record<string, string>, onClose: () => void, currency?: string }) {
  if (!bill) return null;
  const members = group.members;
  const { splitMode, amount, payers, items, desc, ts, attachment, participants } = bill;
  const splits = getExpenseSplits(bill, group);
  const payerEntries = Object.entries(payers).filter(([_, amt]) => (amt || 0) > 0);
  const activeParticipants = participants && participants.length > 0 ? participants : (bill.memberDetails && Object.keys(bill.memberDetails).length > 0 ? Object.keys(bill.memberDetails) : members.filter(m => !(group.memberJoinedAt?.[m]) || group.memberJoinedAt[m] <= ts + 300000));

  return (
    <Modal onClose={onClose}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
        <div style={{ width: 46, height: 46, borderRadius: 13, background: "rgba(11,86,94,0.1)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22 }}>🧾</div>
        <div>
          <div style={{ fontWeight: 800, fontSize: 16, color: "#0b565e" }}>{desc}</div>
          <div style={{ fontSize: 11, color: "#2d666d" }}>{timeAgo(ts)} · {splitMode === "equal" ? "Chia đều" : splitMode === "percent" ? "Theo %" : splitMode === "itemized" ? "Chia theo món" : "Có điều chỉnh"}</div>
        </div>
      </div>

      {attachment && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#2d666d", textTransform: "uppercase", letterSpacing: 1, marginBottom: 7 }}>Ảnh hóa đơn</div>
          <img src={attachment} alt="Attachment" style={{ width: "100%", borderRadius: 12, border: "2px solid rgba(11,86,94,0.2)" }} referrerPolicy="no-referrer" />
        </div>
      )}

      <div style={{ background: "linear-gradient(135deg, #82edc0, #7be0dc)", borderRadius: 12, padding: "12px 16px", marginBottom: 14, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ color: "#0b565e", fontSize: 12, fontWeight: 600 }}>Tổng hóa đơn</span>
        <span style={{ color: "#0b565e", fontWeight: 800, fontSize: 20 }}>{fmt(amount, currency)}</span>
      </div>
      
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#059669", textTransform: "uppercase", letterSpacing: 1, marginBottom: 7 }}>Đã thanh toán ({payerEntries.length})</div>
        {payerEntries.map(([name, amt], i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, background: "#f0fdf4", borderRadius: 11, padding: "9px 13px", marginBottom: 5 }}>
            <Av name={name} size={34} ci={members.indexOf(name)} avatar={memberAvatars?.[name] || bill.memberDetails?.[name]?.avatar} />
            <div style={{ flex: 1 }}><div style={{ fontWeight: 700, fontSize: 13 }}>{name}</div></div>
            <span style={{ fontWeight: 800, fontSize: 14, color: "#059669" }}>{fmt(amt, currency)}</span>
          </div>
        ))}
      </div>

      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#dc2626", textTransform: "uppercase", letterSpacing: 1, marginBottom: 7 }}>Phân chia ({activeParticipants.length})</div>
        {members.map((m, i) => {
          const share = splits[m] || 0;
          const paid = payers[m] || 0;
          const diff = paid - share;
          const isParticipant = activeParticipants.includes(m);
          if (!isParticipant && share <= 0 && paid <= 0) return null;
          
          return (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 9, background: diff >= 0 ? "#f0fdf4" : "#fef2f2", borderRadius: 11, padding: "9px 13px", marginBottom: 5, border: `1.5px solid ${diff >= 0 ? "#bbf7d0" : "#fecaca"}`, opacity: isParticipant || paid > 0 ? 1 : 0.4 }}>
              <Av name={m} size={32} ci={members.indexOf(m)} avatar={memberAvatars?.[m] || bill.memberDetails?.[m]?.avatar} />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 13, color: "#0b565e" }}>{m}</div>
                {Math.abs(Math.round(diff)) >= 1 && (
                  <div style={{ fontSize: 10, display: "flex", alignItems: "center", gap: 4 }}>
                    <span style={{ fontWeight: 900, color: diff >= 0 ? "#16a34a" : "#dc2626", background: diff >= 0 ? "#dcfce7" : "#fee2e2", padding: "1px 4px", borderRadius: 4, fontSize: 9 }}>{diff >= 0 ? "💰 ĐÃ DƯ" : "🔴 CÒN NỢ"}</span>
                    <span style={{ color: "#2d666d" }}>{fmt(Math.abs(diff), currency)}</span>
                  </div>
                )}
              </div>
              <span style={{ fontWeight: 800, fontSize: 13, color: diff >= 0 ? "#16a34a" : "#dc2626" }}>{fmt(share, currency)}</span>
            </div>
          );
        })}
      </div>

      {splitMode === "itemized" && items && items.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#0b565e", textTransform: "uppercase", letterSpacing: 1, marginBottom: 7 }}>Chi tiết món</div>
          <div style={{ background: "rgba(255,255,255,0.4)", borderRadius: 12, padding: "10px 12px", border: "1px solid rgba(11,86,94,0.1)" }}>
            {items.map((it, idx) => (
              <div key={idx} style={{ padding: "8px 0", borderBottom: idx === items.length - 1 ? "none" : "1px solid rgba(11,86,94,0.1)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontWeight: 600 }}>
                  <span style={{ fontSize: 13, color: "#0b565e", flex: 1, paddingRight: 10 }}>{it.name}</span>
                  <span style={{ color: "#0b565e", fontSize: 13, whiteSpace: "nowrap" }}>{fmt(it.price || 0, currency)}</span>
                </div>
                <div style={{ fontSize: 11, color: "#2d666d", marginTop: 4 }}>
                  {it.assignedTo.length > 0 ? it.assignedTo.join(", ") : "Chia đều cả nhóm"}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
        <Btn onClick={onClose} color="#94a3b8" style={{ flex: 1 }}>Đóng</Btn>
      </div>
    </Modal>
  );
}

const EXPENSE_CATEGORIES = [
  { id: "food", label: "Ăn uống", icon: "🍔", color: "#f97316" },
  { id: "transport", label: "Di chuyển", icon: "🚗", color: "#3b82f6" },
  { id: "shopping", label: "Mua sắm", icon: "🛒", color: "#ec4899" },
  { id: "entertainment", label: "Giải trí", icon: "🎭", color: "#8b5cf6" },
  { id: "home", label: "Nhà cửa", icon: "🏠", color: "#10b981" },
  { id: "health", label: "Sức khỏe", icon: "💊", color: "#ef4444" },
  { id: "other", label: "Khác", icon: "📦", color: "#64748b" }
];

function AddExpenseModal({ members, memberAvatars, onAdd, onClose, currency = "đ" }: { members: string[], memberAvatars?: Record<string, string>, onAdd: (e: Expense) => void, onClose: () => void, currency?: string }) {
  const [desc, setDesc] = useState("");
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState("food");
  const [payers, setPayers] = useState<Record<string, number>>({});
  const [mode, setMode] = useState("equal");
  const [splits, setSplits] = useState<Record<string, number>>({});
  const [participants, setParticipants] = useState<string[]>(members);
  const [attachment, setAttachment] = useState<string | null>(null);
  
  const [items, setItems] = useState<ReceiptItem[]>([]);
  const [isScanning, setIsScanning] = useState(false);

  const amt = Math.round(parseFloat(amount)) || 0;

  useEffect(() => {
    const keys = Object.keys(payers);
    if (!amt) {
      setPayers({});
      return;
    }
    if (keys.length === 1) {
      setPayers({ [keys[0]]: amt });
    } else if (keys.length > 1) {
      const share = Math.floor(amt / members.length);
      const rem = amt % members.length;
      const p: any = {};
      members.forEach((m, i) => p[m] = share + (i < rem ? 1 : 0));
      setPayers(p);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amt]);

  const payerVals = Object.values(payers) as number[];
  const totalPaid = payerVals.reduce((s: number, v: number) => s + (v || 0), 0);

  const updateSplit = (m: string, val: string) => setSplits(s => ({ ...s, [m]: Math.round(parseFloat(val)) || 0 }));

  const totalPct = participants.reduce((s: number, m: string) => s + (splits[m] || 0), 0);
  const totalAdj = participants.reduce((s: number, m: string) => s + (splits[m] || 0), 0);

  const valid = desc.trim() && amt > 0 && Math.abs(totalPaid - amt) < 1 && (
    mode === "equal" ||
    (mode === "percent" && Math.abs(totalPct - 100) < 0.01) ||
    (mode === "adjust" && Math.abs(totalAdj) < 1) ||
    mode === "itemized"
  );

  const handleAdd = () => {
    if (!valid) return;
    const expData: any = { 
      id: String(Date.now()), 
      desc: desc.trim(), 
      amount: amt, 
      category,
      payers: { ...payers }, 
      splitMode: mode, 
      splits: { ...splits },
      participants: participants,
      attachment: attachment || undefined,
      ts: Date.now() 
    };
    if (mode === "itemized") expData.items = items;
    onAdd(expData);
    onClose();
  };

  const uploadAttachment = (file: File) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = (ev) => {
      setAttachment(ev.target?.result as string);
    };
  };

  const scanReceipt = async (file: File) => {
    setIsScanning(true);
    uploadAttachment(file); // Also save as attachment
    try {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = async (ev) => {
        const imageStr = ev.target?.result as string;
        const base64Data = imageStr.split(",")[1];
        const mimeType = imageStr.substring(imageStr.indexOf(":")+1, imageStr.indexOf(";"));
        
        const response = await ai.models.generateContent({
          model: "gemini-3.1-pro-preview",
          contents: {
            parts: [
              { inlineData: { data: base64Data, mimeType } },
              { text: "Extract receipt items and prices. Return a JSON array of objects. Format: [{ name: 'item name', price: 1000 }]. No markdown, just JSON." }
            ]
          },
          config: {
            responseMimeType: "application/json",
            responseSchema: {
              type: Type.ARRAY,
              items: { type: Type.OBJECT, properties: { name: { type: Type.STRING }, price: { type: Type.NUMBER } } }
            }
          }
        });
        
        const parsed = JSON.parse(response.text || "[]");
        const list = parsed.map((p: any) => ({ ...p, assignedTo: [] }));
        setItems(list);
        setMode("itemized");
        const tot = list.reduce((s:number,it:any)=>s+(it.price||0), 0);
        setAmount(tot.toString());
        if (!desc.trim()) setDesc("Hóa đơn");
        setIsScanning(false);
      };
    } catch(err) {
      console.error(err);
      alert("Quét hoá đơn thất bại.");
      setIsScanning(false);
    }
  };

  const toggleAssign = (itemIdx: number, memberName: string) => {
    const newItems = [...items];
    const it = newItems[itemIdx];
    if (it.assignedTo.includes(memberName)) {
      it.assignedTo = it.assignedTo.filter(m => m !== memberName);
    } else {
      it.assignedTo.push(memberName);
    }
    setItems(newItems);
  };

  const toggleParticipant = (m: string) => {
    if (participants.includes(m)) {
      setParticipants(participants.filter(p => p !== m));
    } else {
      setParticipants([...participants, m]);
    }
  };

  return (
    <Modal onClose={onClose}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 44, height: 44, borderRadius: 13, background: "#dbeafe", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22 }}>🧾</div>
          <div style={{ fontWeight: 800, fontSize: 16, color: "#1e1e2e" }}>Thêm Khoản Chi</div>
        </div>
        <div style={{ display: "flex", gap: 5 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6, background: "linear-gradient(135deg, #0b565e, #147f87)", color: "#fff", padding: "6px 10px", borderRadius: 8, fontSize: 11, fontWeight: 700, cursor: "pointer", boxShadow: "0 2px 5px rgba(11,86,94,0.3)" }}>
           {isScanning ? <Loader2 size={18} className="animate-spin"/> : <Camera size={18}/>}
             {isScanning ? "Đang quét..." : "Chụp AI"}
             <input type="file" accept="image/*" capture="environment" onChange={(e) => { if(e.target.files?.[0]) scanReceipt(e.target.files[0]); }} style={{ display: "none" }} />
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6, background: "#f8fafc", border: "1px solid #cbd5e1", color: "#64748b", padding: "6px 10px", borderRadius: 8, fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
             <ImagePlus size={14}/>
             {attachment ? "Đã đính kèm" : "Ảnh"}
             <input type="file" accept="image/*" onChange={(e) => { 
               const file = e.target.files?.[0];
               if (file) {
                 if (file.size > 500 * 1024) { alert("🚨 Ảnh quá lớn (tối đa 500KB)"); return; }
                 uploadAttachment(file); 
               }
             }} style={{ display: "none" }} />
          </label>
        </div>
      </div>

      {attachment && (
        <div style={{ position: "relative", marginBottom: 12, textAlign: "center" }}>
          <img src={attachment} style={{ maxHeight: 120, borderRadius: 12, boxShadow: "0 4px 12px rgba(0,0,0,0.1)", border: "2px solid #f1f5f9" }} />
          <button onClick={() => setAttachment(null)} style={{ position: "absolute", top: -8, right: "calc(50% - 70px)", background: "#ef4444", color: "#fff", border: "none", width: 24, height: 24, borderRadius: "50%", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, boxShadow: "0 2px 4px rgba(0,0,0,0.2)" }}>×</button>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
        <Input placeholder="Mô tả" value={desc} onChange={(e: any) => setDesc(e.target.value)} />
        <Input placeholder="Số tiền" type="text" inputMode="numeric" value={formatNum(amount)} onChange={(e: any) => setAmount(parseNumStr(e.target.value))} />

        <div style={{ marginBottom: 4 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>Phân loại</div>
          <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 6, scrollbarWidth: "none" }}>
            {EXPENSE_CATEGORIES.map(cat => (
              <div 
                key={cat.id} 
                onClick={() => setCategory(cat.id)}
                style={{
                  display: "flex", flexDirection: "column", alignItems: "center", gap: 4, padding: "8px 12px", borderRadius: 12, cursor: "pointer", flexShrink: 0,
                  transition: "all 0.2s", background: category === cat.id ? `${cat.color}15` : "#f8fafc", border: category === cat.id ? `2px solid ${cat.color}` : "2px solid #f1f5f9"
                }}
              >
                <span style={{ fontSize: 18 }}>{cat.icon}</span>
                <span style={{ fontSize: 10, fontWeight: 700, color: category === cat.id ? cat.color : "#64748b" }}>{cat.label}</span>
              </div>
            ))}
          </div>
        </div>

        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6, display: "flex", justifyContent: "space-between" }}>
            <span>Người trả</span>
          </div>
          
          <div style={{ display: "flex", gap: 6, marginBottom: 10, overflowX: "auto", paddingBottom: 4 }}>
            <button 
              onClick={() => setPayers({ [members[0]]: amt })} 
              style={{ background: payers[members[0]] === amt ? "#059669" : "#f1f5f9", color: payers[members[0]] === amt ? "#fff" : "#64748b", border: "none", borderRadius: 8, padding: "6px 12px", fontSize: 11, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" }}
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
              style={{ background: totalPaid === amt && Object.keys(payers).length > 1 ? "#059669" : "#f1f5f9", color: totalPaid === amt && Object.keys(payers).length > 1 ? "#fff" : "#64748b", border: "none", borderRadius: 8, padding: "6px 12px", fontSize: 11, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" }}
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
                  <Av name={m} size={30} ci={i} avatar={memberAvatars?.[m]} />
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
          <div style={{ fontSize: 11, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>Chi tiền cho</span>
            <button onClick={() => setParticipants(participants.length === members.length ? [members[0]] : members)} style={{ fontSize: 10, background: "#ecfdf5", color: "#059669", border: "none", padding: "2px 8px", borderRadius: 6, fontWeight: 700, cursor: "pointer" }}>
              {participants.length === members.length ? "Bỏ tất cả" : "Chọn tất cả"}
            </button>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, background: "#f8fafc", borderRadius: 12, padding: "10px 12px" }}>
            {members.map((m, i) => {
              const isP = participants.includes(m);
              return (
                <div key={i} onClick={() => toggleParticipant(m)} style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 10px", borderRadius: 20, border: `1.5px solid ${isP ? "#059669" : "#e2e8f0"}`, background: isP ? "#f0fdf4" : "#fff", cursor: "pointer", transition: "all 0.2s" }}>
                  <Av name={m} size={20} ci={i} avatar={memberAvatars?.[m]} />
                  <span style={{ fontSize: 11, fontWeight: 600, color: isP ? "#059669" : "#64748b" }}>{m}</span>
                </div>
              );
            })}
          </div>
        </div>

        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>Kiểu chia</div>
          <div style={{ display:"flex", background: "#f1f5f9", borderRadius:10, padding:3, gap:2 }}>
            {[["equal", "⚖️ Đều"], ["percent", "📊 %"], ["adjust", "🔧 Adj"], ["itemized", "🍔 Món"]].map(([v, l]) => (
              <button key={v} onClick={() => setMode(v)} style={{ flex: 1, padding: "7px 4px", border: "none", borderRadius: 8, background: mode === v ? "#059669" : "transparent", color: mode === v ? "#fff" : "#64748b", fontWeight: 700, fontSize: 11, cursor: "pointer", whiteSpace: "nowrap" }}>{l}</button>
            ))}
          </div>
        </div>

        {mode === "equal" && amt > 0 && participants.length > 0 && (
          <div style={{ background: "#f0fdf4", borderRadius: 12, padding: "12px", border: "1.5px solid #bbf7d0" }}>
             <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: "#16a34a" }}>⚖️ Chia đều:</span>
                <span style={{ fontSize: 16, fontWeight: 800, color: "#16a34a" }}>{fmt(amt / participants.length, currency)} / người</span>
             </div>
             <div style={{ fontSize: 10, color: "#16a34a", marginTop: 4, opacity: 0.8 }}>Hệ thống tự động tính cho {participants.length} thành viên tham gia</div>
          </div>
        )}

        {mode === "itemized" && (
           <div style={{ background: "#f8fafc", borderRadius: 12, padding: "10px 12px" }}>
            {items.length === 0 && <div style={{fontSize: 12, color: "#94a3b8", textAlign: "center", padding: 10}}>Bấm nút "Quét AI" ở trên để phân tích hóa đơn, hoặc chọn kiểu chia khác.</div>}
            {items.map((it, idx) => (
              <div key={idx} style={{marginBottom: 12, padding: "10px", border: "1px solid #e2e8f0", borderRadius: 10, background: "#fff"}}>
                <div style={{display: "flex", justifyContent: "space-between", fontWeight: 600, marginBottom: 8}}>
                  <span style={{fontSize: 13, color: "#1e293b"}}>{it.name}</span>
                  <span style={{color: "#ec4899", fontSize: 13}}>{fmt(it.price || 0, currency)}</span>
                </div>
                <div style={{display: "flex", flexWrap: "wrap", gap: 6}}>
                  {members.map(m => {
                    const isAsg = it.assignedTo.includes(m);
                    return (
                      <button key={m} onClick={() => toggleAssign(idx, m)} style={{padding: "4px 10px", borderRadius: 12, border: `1px solid ${isAsg ? "#ec4899" : "#cbd5e1"}`, background: isAsg ? "#fdf2f8" : "#fff", color: isAsg ? "#be185d" : "#64748b", fontSize: 11, fontWeight: 600, cursor: "pointer"}}>
                        {m}
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
           </div>
        )}

        {mode !== "equal" && mode !== "itemized" && (
          <div style={{ background: "#f8fafc", borderRadius: 12, padding: "10px 12px" }}>
            {mode === "percent" && (
              <>
                <div style={{ fontSize: 11, color: Math.abs(totalPct - 100) < 0.01 ? "#059669" : "#dc2626", fontWeight: 700, marginBottom: 8 }}>Tổng: {totalPct}%</div>
                {members.map((m, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <Av name={m} size={26} ci={i} avatar={memberAvatars?.[m]}/><span style={{ flex: 1, fontSize: 12, fontWeight: 600 }}>{m}</span>
                    <input type="number" value={splits[m] || ""} onChange={e => updateSplit(m, e.target.value)} placeholder="0" style={{ width: 60, border: "2px solid #e2e8f0", borderRadius: 8, padding: "5px 7px", fontSize: 13, outline: "none", textAlign: "right" }} />
                    <span style={{ fontSize: 11, color: "#94a3b8", minWidth: 60 }}>{fmt((splits[m] || 0) / 100 * amt, currency)}</span>
                  </div>
                ))}
              </>
            )}
            {mode === "adjust" && (
              <>
                <div style={{ fontSize: 11, color: Math.abs(totalAdj) < 1 ? "#059669" : "#dc2626", fontWeight: 700, marginBottom: 8 }}>Bù: {fmt(totalAdj, currency)}</div>
                {members.map((m, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <Av name={m} size={26} ci={i} avatar={memberAvatars?.[m]}/><span style={{ flex: 1, fontSize: 12, fontWeight: 600 }}>{m}</span>
                    <input 
                      type="text" 
                      inputMode="numeric"
                      value={formatNum(splits[m] || "")} 
                      onChange={e => {
                        const val = parseNum(e.target.value);
                        setSplits(s => ({ ...s, [m]: val }));
                      }} 
                      placeholder="0" />
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

function PayModal({ members, memberAvatars, transactions, onPay, onClose, currency = "đ" }: { members: string[], memberAvatars?: Record<string, string>, transactions: any[], onPay: (p: Payment) => void, onClose: () => void, currency?: string }) {
  const [from,setFrom]=useState(transactions[0]?.from||members[0]||"");
  const [to,setTo]=useState(transactions[0]?.to||"");
  const [amount,setAmount]=useState(transactions[0]?Math.round(transactions[0].amount):"");
  const [note,setNote]=useState("");
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'ewallet'>('cash');
  const [simulationStep, setSimulationStep] = useState<'none' | 'processing' | 'success'>('none');
  const suggested = transactions.find(t=>t.from===from&&t.to===to);

  const handlePay = (overrideAmt?: number) => {
    const amt = overrideAmt !== undefined ? overrideAmt : Math.round(parseFloat(amount as string));
    if(!from||!to||from===to||isNaN(amt)||amt<=0) return;
    
    if (paymentMethod === 'ewallet') {
      setSimulationStep('processing');
      setTimeout(() => {
        setSimulationStep('success');
        setTimeout(() => {
          onPay({id: String(Date.now()), from,to,amount:amt,note:note.trim() + " (Chuyển khoản)",ts:Date.now()});
          onClose();
        }, 1500);
      }, 2000);
      return;
    }

    onPay({id: String(Date.now()), from,to,amount:amt,note:note.trim(),ts:Date.now()});
    onClose();
  };

  if (simulationStep !== 'none') {
    return (
      <Modal onClose={() => {}}>
        <div style={{ padding: "40px", textAlign: "center" }}>
          {simulationStep === 'processing' ? (
            <>
              <div style={{ fontSize: 60, marginBottom: 20 }}>🔄</div>
              <div style={{ fontSize: 18, fontWeight: 800, color: "#1e1e2e" }}>Đang chuyển khoản...</div>
            </>
          ) : (
            <>
              <div style={{ fontSize: 60, marginBottom: 20 }}>✅</div>
              <div style={{ fontSize: 18, fontWeight: 800, color: "#059669" }}>Chuyển khoản thành công!</div>
            </>
          )}
        </div>
      </Modal>
    );
  }

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
            <button key={i} onClick={()=>{setFrom(m);const s=transactions.find(t=>t.from===m);if(s){setTo(s.to);setAmount(Math.round(s.amount).toString());}}} style={{display:"flex",alignItems:"center",gap:5,padding:"5px 10px 5px 5px",borderRadius:18,border:`2px solid ${from===m?"#059669":"#e2e8f0"}`,background:from===m?"#f0fdf4":"#fff",cursor:"pointer"}}>
              <Av name={m} size={22} ci={i} avatar={memberAvatars?.[m]}/><span style={{fontSize:12,fontWeight:600,color:from===m?"#059669":"#374151"}}>{m}</span>
            </button>
          ))}
        </div>
      </div>
      <div style={{marginBottom:10}}>
        <div style={{fontSize:11,fontWeight:700,color:"#64748b",textTransform:"uppercase",marginBottom:6}}>Người nhận</div>
        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
          {members.filter(m=>m!==from).map((m,i)=>(
            <button key={i} onClick={()=>{setTo(m);const s=transactions.find(t=>t.from===from&&t.to===m);if(s)setAmount(Math.round(s.amount).toString());}} style={{display:"flex",alignItems:"center",gap:5,padding:"5px 10px 5px 5px",borderRadius:18,border:`2px solid ${to===m?"#059669":"#e2e8f0"}`,background:to===m?"#f0fdf4":"#fff",cursor:"pointer"}}>
              <Av name={m} size={22} ci={members.indexOf(m)} avatar={memberAvatars?.[m]}/><span style={{fontSize:12,fontWeight:600,color:to===m?"#059669":"#374151"}}>{m}</span>
            </button>
          ))}
        </div>
      </div>
      {suggested&&<div style={{background:"#fff7ed",borderRadius:9,padding:"7px 11px",marginBottom:10,fontSize:12,color:"#d97706",display:"flex",alignItems:"center",gap:6}}>💡 <span><b>{from}</b> cần trả <b>{fmt(suggested.amount, currency)}</b></span><button onClick={()=>handlePay(Math.round(suggested.amount))} style={{marginLeft:"auto",background:"#d97706",color:"#fff",border:"none",borderRadius:6,padding:"3px 8px",fontSize:11,fontWeight:700,cursor:"pointer"}}>Dùng</button></div>}
      <Input 
        placeholder="Số tiền" 
        type="text" 
        inputMode="numeric"
        value={formatNum(amount)} 
        onChange={(e: any)=>setAmount(parseNumStr(e.target.value))} 
        style={{marginBottom:8}}
      />
      <Input placeholder="Ghi chú (tuỳ chọn)" value={note} onChange={(e: any)=>setNote(e.target.value)} style={{marginBottom:12}}/>
      
      <div style={{fontSize:11,fontWeight:700,color:"#64748b",textTransform:"uppercase",marginBottom:6}}>Phương thức thanh toán</div>
      <div style={{display:"flex",background:"#f1f5f9",borderRadius:10,padding:3,gap:2,marginBottom:16}}>
        <div onClick={() => setPaymentMethod('cash')} style={{flex:1,padding:"7px 4px",borderRadius:8,background:paymentMethod==='cash'?"#059669":"transparent",color:paymentMethod==='cash'?"#fff":"#64748b",textAlign:"center",fontWeight:700,fontSize:12,cursor:"pointer"}}>💵 Tiền mặt</div>
        <div onClick={() => setPaymentMethod('ewallet')} style={{flex:1,padding:"7px 4px",borderRadius:8,background:paymentMethod==='ewallet'?"#059669":"transparent",color:paymentMethod==='ewallet'?"#fff":"#64748b",textAlign:"center",fontWeight:700,fontSize:12,cursor:"pointer"}}>📱 Ví điện tử</div>
      </div>

      <Btn onClick={() => handlePay()} color="linear-gradient(135deg,#059669,#34d399)" style={{width:"100%"}}>✅ Xác nhận thanh toán</Btn>
    </Modal>
  );
}

function GroupSettingsModal({ group, friends, currentUser, memberAvatars, onClose, onUpdate, onLeave, onDelete, sendInviteEmail }: { group: Group, friends: Friend[], currentUser: string, memberAvatars?: Record<string, string>, onClose: () => void, onUpdate: (g: Group) => void, onLeave: () => void, onDelete: () => void, sendInviteEmail: (email: string, inviterName: string, groupName?: string, inviteCode?: string, groupId?: string) => Promise<boolean> }) {
  const [newMemberName, setNewMemberName] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [sendingInvite, setSendingInvite] = useState(false);
  const isLeader = group.leaderUid ? group.leaderUid === auth.currentUser?.uid : group.leader === currentUser;
  const [copiedCode, setCopiedCode] = useState(false);

  const inviteLink = `${window.location.origin}/?joinCode=${group.inviteCode}`;

  const copyCode = () => {
    navigator.clipboard.writeText(inviteLink);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  };

  const handleSendInvite = async () => {
    if (!inviteEmail.trim() || sendingInvite) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inviteEmail.trim())) {
      alert("Email không hợp lệ!");
      return;
    }
    setSendingInvite(true);
    const success = await sendInviteEmail(inviteEmail.trim(), currentUser, group.name, group.inviteCode, group.id);
    if (success) {
      alert("📧 Đã gửi lời mời tới " + inviteEmail);
      setInviteEmail("");
    } else {
      alert("❌ Gửi lời mời thất bại. Kiểm tra SMTP.");
    }
    setSendingInvite(false);
  };

  const addMember = () => {
    const input = newMemberName.trim();
    if (!input) return;

    if (group.members.includes(input)) {
      alert("Thành viên này đã có trong nhóm!");
      return;
    }
    const dummyUid = "m_" + Date.now();
    const newM = [...group.members, input];
    const newUids = [...group.memberUids, dummyUid];
    const newDetails = { ...(group.memberDetails || {}), [input]: { avatar: "" } };
    const newJoinedAt = { ...(group.memberJoinedAt || {}), [input]: Date.now() };
    onUpdate({ ...group, members: newM, memberUids: newUids, memberDetails: newDetails, memberJoinedAt: newJoinedAt });
    setNewMemberName("");
  };

  const addFriend = (f: Friend) => {
    if (group.members.includes(f.name)) {
      alert("Bạn này đã có trong nhóm rồi!");
      return;
    }
    const dummyUid = "m_" + Date.now();
    const newM = [...group.members, f.name];
    const newUids = [...group.memberUids, dummyUid];
    const newDetails = { ...(group.memberDetails || {}), [f.name]: { avatar: f.avatar || "" } };
    const newJoinedAt = { ...(group.memberJoinedAt || {}), [f.name]: Date.now() };
    onUpdate({ ...group, members: newM, memberUids: newUids, memberDetails: newDetails, memberJoinedAt: newJoinedAt });
  };

  return (
    <Modal onClose={onClose}>
      <div style={{fontWeight:800,fontSize:16,marginBottom:16,color:"#1e1e2e"}}>⚙️ Cài đặt nhóm</div>

      <Card style={{background:"#f5f3ff",marginBottom:10}}>
        <SecTitle icon="🔗" title="Link mời bạn bè" color="#059669" />
        
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
          <div style={{flex:1,background:"#ecfdf5",borderRadius:9,padding:"10px 14px",fontWeight:800,fontSize:14,color:"#059669",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{inviteLink}</div>
          <button onClick={copyCode} style={{background:copiedCode?"#059669":"#059669",color:"#fff",border:"none",borderRadius:9,padding:"10px 14px",fontWeight:700,fontSize:12,cursor:"pointer"}}>{copiedCode?"✅":"📋"}</button>
        </div>

        <div style={{fontWeight: 700, fontSize: 12, color: "#64748b", marginBottom: 8}}>GỬI QUA EMAIL</div>
        <div style={{display: "flex", gap: 8, marginBottom: 15}}>
          <Input placeholder="Email bạn bè..." value={inviteEmail} onChange={(e: any) => setInviteEmail(e.target.value)} style={{fontSize: 13, flex: 1}} />
          <Btn onClick={handleSendInvite} disabled={sendingInvite} style={{fontSize: 13, whiteSpace: "nowrap"}}>{sendingInvite ? "Đang gửi..." : "Mời 📧"}</Btn>
        </div>

        <div style={{fontWeight: 700, fontSize: 12, color: "#64748b", marginBottom: 8}}>MÃ QR VÀO NHÓM</div>
        <div style={{display: "flex", justifyContent: "center", background: "#fff", padding: 15, borderRadius: 12, border: "2px solid #ecfdf5"}}>
           <QRCode value={inviteLink} size={150} level="Q" />
        </div>
      </Card>

      <Card style={{marginBottom:10}}>
        <SecTitle icon="👥" title="Thành viên nhóm" color="#2563eb"/>
        <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:12}}>
          {group.members.map((m,i)=>(
            <div key={i} style={{display:"flex",alignItems:"center",gap:8,background:"#f8fafc",padding:"8px 10px",borderRadius:10}}>
              <Av name={m} size={28} ci={group.members.indexOf(m)} avatar={memberAvatars?.[m] || group.memberDetails?.[m]?.avatar}/>
              <span style={{flex:1,fontSize:13,fontWeight:600}}>{m}</span>
              {m !== group.leader && isLeader && (
                <div onClick={() => {
                   const newM = group.members.filter(x => x !== m);
                   const newUids = group.memberUids.filter((_, idx) => group.members[idx] !== m);
                   const newDetails = { ...group.memberDetails };
                   delete newDetails[m];
                   onUpdate({ ...group, members: newM, memberUids: newUids, memberDetails: newDetails });
                }} style={{ background: "none", border: "none", color: "#dc2626", fontSize: 18, cursor: "pointer" }}>×</div>
              )}
            </div>
          ))}
        </div>
        
        <div style={{ height: 1, background: "#f1f5f9", margin: "14px 0" }} />
        
        <div style={{ fontWeight: 700, fontSize: 12, color: "#64748b", marginBottom: 8 }}>THÊM TỪ BẠN BÈ</div>
        <div style={{ display: "flex", gap: 8, overflowX: "auto", background: "#f8fafc", padding: "10px", borderRadius: 12, border: "1px solid #e2e8f0", marginBottom: 15, scrollbarWidth: "none" }}>
          {friends.filter(f => !group.members.includes(f.name)).map((f, i) => (
            <div key={i} onClick={() => addFriend(f)} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 5, flexShrink: 0, cursor: "pointer" }}>
              <Av name={f.name} size={40} avatar={f.avatar} />
              <div style={{ fontSize: 10, fontWeight: 700, color: "#475569", width: 45, textAlign: "center", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name.split(" ")[0]}</div>
            </div>
          ))}
          {friends.length === 0 && <div style={{ fontSize: 11, color: "#94a3b8", textAlign: "center", width: "100%" }}>Chưa có bạn bè để thêm.</div>}
        </div>

        <div style={{ fontWeight: 700, fontSize: 12, color: "#64748b", marginBottom: 8 }}>THÊM THÀNH VIÊN (Nhập tên)</div>
        <div style={{ display: "flex", gap: 8 }}>
          <Input placeholder="Nhập tên thành viên..." value={newMemberName} onChange={(e: any) => setNewMemberName(e.target.value)} style={{ fontSize: 13, flex: 1 }} />
          <Btn onClick={addMember} style={{ fontSize: 13 }}>Thêm</Btn>
        </div>
      </Card>
      <div style={{display:"flex",flexDirection:"column",gap:8}}>
        <button onClick={onLeave} style={{background:"#fff7ed",color:"#d97706",border:"2px solid #fed7aa",borderRadius:11,padding:"11px",fontWeight:700,fontSize:13,cursor:"pointer"}}>👋 Rời nhóm</button>
        {isLeader&&<button onClick={onDelete} style={{background:"#fef2f2",color:"#dc2626",border:"2px solid #fecaca",borderRadius:11,padding:"11px",fontWeight:700,fontSize:13,cursor:"pointer"}}>🗑️ Xóa nhóm</button>}
      </div>
    </Modal>
  );
}

function GroupStats({ group, expenses, payments, balances, currency = "đ" }: { group: Group, expenses: Expense[], payments: Payment[], balances: Record<string, number>, transactions: any[], currency?: string }) {
  const [chartView,setChartView]=useState("spend"); // spend | debt | cat | trend
  const members=group.members;

  // ─── Trend Data ───
  const trendData = useMemo(() => {
    const daily: Record<string, number> = {};
    const sorted = [...expenses].sort((a,b) => a.ts - b.ts);
    sorted.forEach(e => {
      const d = new Date(e.ts).toLocaleDateString("vi-VN", { day: "numeric", month: "numeric" });
      daily[d] = (daily[d] || 0) + e.amount;
    });
    return Object.entries(daily).map(([name, amount]) => ({ name, amount }));
  }, [expenses]);

  // ─── Category Data ───
  const categoryData = useMemo(() => {
    const cats: Record<string, number> = {};
    expenses.forEach(e => {
      const c = e.category || "other";
      cats[c] = (cats[c] || 0) + e.amount;
    });
    return EXPENSE_CATEGORIES.map(c => ({
      name: c.label,
      value: cats[c.id] || 0,
      color: c.color,
      icon: c.icon
    })).filter(d => d.value > 0).sort((a,b) => b.value - a.value);
  }, [expenses]);

  const memberStats = useMemo(() => {
    // We pre-calculate all splits for all expenses
    const expenseSplits = expenses.map(e => getExpenseSplits(e, group));
    
    return members.map((m, i) => {
      const share = expenses.reduce((s, e, idx) => s + (expenseSplits[idx][m] || 0), 0);
      const actuallyPaid = expenses.reduce((s, e) => s + Math.round(e.payers[m] || 0), 0);
      const settlementsSent = payments.filter(p => p.from === m).reduce((s, p) => s + Math.round(p.amount), 0);
      const settlementsReceived = payments.filter(p => p.to === m).reduce((s, p) => s + Math.round(p.amount), 0);
      
      const contribution = actuallyPaid + settlementsSent - settlementsReceived;
      const balance = contribution - share;
      
      const isDebt = Math.round(balance) <= -1;
      const paidPortion = isDebt ? contribution : share;
      const remainingPortion = isDebt ? (share - contribution) : 0;
      const extraPortion = isDebt ? 0 : (contribution - share);

      return {
        name: m,
        paid: actuallyPaid, 
        contribution, 
        share,
        balance,
        paidPortion,
        remainingPortion,
        extraPortion,
        color: COLORS[i % COLORS.length]
      };
    });
  }, [expenses, members, payments]);

  const totalSpend = useMemo(() => expenses.reduce((s, e) => s + Math.round(e.amount), 0), [expenses]);

  const CustomTooltip = ({ active, payload }: any) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload;
      return (
        <div style={{ background: "white", padding: "8px 12px", border: "1px solid #e2e8f0", borderRadius: 8, boxShadow: "0 4px 6px -1px rgb(0 0 0 / 0.1)" }}>
          <p style={{ fontWeight: 700, margin: 0, fontSize: 12, color: "#1e293b" }}>{data.name}</p>
          {chartView === "spend" ? (
            <p style={{ margin: 0, fontSize: 12, fontWeight: 800, color: data.color }}>{fmt(data.paid, currency)}</p>
          ) : (
            <>
              <p style={{ margin: 0, fontSize: 11, color: "#64748b" }}>Đã góp: <span style={{ fontWeight: 700, color: "#059669" }}>{fmt(data.contribution, currency)}</span></p>
              <p style={{ margin: 0, fontSize: 11, color: "#64748b" }}>Phần chi: <span style={{ fontWeight: 700, color: "#1e293b" }}>{fmt(data.share, currency)}</span></p>
              <p style={{ margin: 0, fontSize: 11, fontWeight: 700, color: Math.round(data.balance) >= 1 ? "#059669" : Math.round(data.balance) <= -1 ? "#dc2626" : "#64748b" }}>
                {Math.abs(Math.round(data.balance)) >= 1 ? (data.balance > 0 ? "Dư: +" : "Nợ: ") : "Đã xong"}
                {Math.abs(Math.round(data.balance)) >= 1 ? fmt(data.balance, currency) : ""}
              </p>
            </>
          )}
        </div>
      );
    }
    return null;
  };

  return (
    <Card>
      <SecTitle icon="📊" title="Thống kê" color="#2563eb"/>
      <div style={{display:"flex",background:"#f1f5f9",borderRadius:10,padding:3,gap:2,marginBottom:20}}>
        {[["spend","💰 Tiền chi"],["debt","⚖️ Nợ"],["cat","📂 Loại"],["trend","📈 Xu hướng"]].map(([v,l])=>(
          <button key={v} onClick={()=>setChartView(v)} style={{flex:1,padding:"8px 1px",border:"none",borderRadius:8,background:chartView===v?"#059669":"transparent",color:chartView===v?"#fff":"#64748b",fontWeight:700,fontSize:10,transition:"all 0.2s",cursor:"pointer"}}>{l}</button>
        ))}
      </div>

      <div style={{ height: members.length * 50 + 100, minHeight: 250 }}>
        <ResponsiveContainer width="100%" height="100%">
          {chartView === "spend" ? (
            <BarChart data={memberStats} layout="vertical" margin={{ top: 5, right: 15, left: -20, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#f1f5f9" />
              <XAxis type="number" fontSize={10} stroke="#94a3b8" tickFormatter={(v)=>fmtShort(v, currency)} />
              <YAxis dataKey="name" type="category" fontSize={11} fontWeight={600} stroke="#475569" width={75} />
              <Tooltip content={<CustomTooltip />} cursor={{ fill: "#f8fafc" }} />
              <Bar dataKey="paid" radius={[0, 4, 4, 0]} barSize={24}>
                {memberStats.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={entry.color} />
                ))}
              </Bar>
            </BarChart>
          ) : chartView === "debt" ? (
            <BarChart data={memberStats} layout="vertical" margin={{ top: 5, right: 15, left: -20, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#f1f5f9" />
              <XAxis type="number" fontSize={10} stroke="#94a3b8" tickFormatter={(v)=>fmtShort(v, currency)} />
              <YAxis dataKey="name" type="category" fontSize={11} fontWeight={600} stroke="#475569" width={75} />
              <Tooltip content={<CustomTooltip />} cursor={{ fill: "#f8fafc" }} />
              <Bar dataKey="paidPortion" stackId="a" fill="#059669" radius={[0, 0, 0, 0]} barSize={24} name="Đã trả" opacity={0.8} />
              <Bar dataKey="remainingPortion" stackId="a" fill="#dc2626" radius={[0, 4, 4, 0]} name="Còn nợ" />
              <Bar dataKey="extraPortion" stackId="a" fill="#3b82f6" radius={[0, 4, 4, 0]} name="Trả dư" />
              <ReferenceLine x={0} stroke="#64748b" />
            </BarChart>
          ) : chartView === "cat" ? (
            <BarChart data={categoryData} layout="vertical" margin={{ top: 5, right: 15, left: -20, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#f1f5f9" />
              <XAxis type="number" fontSize={10} stroke="#94a3b8" tickFormatter={(v)=>fmtShort(v, currency)} />
              <YAxis dataKey="name" type="category" fontSize={11} fontWeight={600} stroke="#475569" width={75} />
              <Tooltip formatter={(v:any)=>fmt(v)} cursor={{ fill: "#f8fafc" }} />
              <Bar dataKey="value" radius={[0, 4, 4, 0]} barSize={24}>
                {categoryData.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={entry.color} />
                ))}
              </Bar>
            </BarChart>
          ) : (
            <AreaChart data={trendData} margin={{ top: 10, right: 10, left: 10, bottom: 20 }}>
              <defs>
                <linearGradient id="colorAmt" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#059669" stopOpacity={0.3}/>
                  <stop offset="95%" stopColor="#34d399" stopOpacity={0}/>
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
              <XAxis dataKey="name" fontSize={10} stroke="#94a3b8" dy={10} />
              <YAxis fontSize={10} stroke="#94a3b8" tickFormatter={(v)=>fmtShort(v, currency)} width={40} />
              <Tooltip formatter={(v:any)=>fmt(v)} />
              <Area type="monotone" dataKey="amount" stroke="#059669" strokeWidth={3} fillOpacity={1} fill="url(#colorAmt)" />
            </AreaChart>
          )}
        </ResponsiveContainer>
      </div>

      <div style={{ marginTop: 16, display: "flex", flexWrap: "wrap", gap: 12, justifyContent: "center" }}>
        {chartView === "spend" ? (
          <div style={{fontSize:12,color:"#64748b"}}>Tổng chi tiêu nhóm: <b style={{color:"#059669"}}>{fmt(totalSpend, currency)}</b></div>
        ) : chartView === "debt" ? (
          <div style={{display:"flex",gap:12}}>
            <div style={{display:"flex",alignItems:"center",gap:4,fontSize:11,color:"#64748b"}}>
              <div style={{width:8,height:8,background:"#059669",borderRadius:2}}/> Đã trả
            </div>
            <div style={{display:"flex",alignItems:"center",gap:4,fontSize:11,color:"#64748b"}}>
              <div style={{width:8,height:8,background:"#dc2626",borderRadius:2}}/> Còn nợ
            </div>
            <div style={{display:"flex",alignItems:"center",gap:4,fontSize:11,color:"#64748b"}}>
              <div style={{width:8,height:8,background:"#3b82f6",borderRadius:2}}/> Trả dư
            </div>
          </div>
        ) : chartView === "cat" ? (
           <div style={{fontSize:11,color:"#64748b"}}>Danh mục chi tiêu nhiều nhất: <b style={{color:"#1e293b"}}>{categoryData[0]?.name || "N/A"} ({fmt(categoryData[0]?.value || 0, currency)})</b></div>
        ) : (
           <div style={{fontSize:11,color:"#64748b"}}>Tần suất chi tiêu: <b style={{color:"#1e293b"}}>{expenses.length} khoản chi</b></div>
        )}
      </div>

      <div style={{marginTop: 20, paddingTop: 16, borderTop: "1px dashed #e2e8f0", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10}}>
        <div style={{background: "#f8fafc", padding: 10, borderRadius: 12}}>
          <div style={{fontSize: 10, color: "#64748b", fontWeight: 700, textTransform: "uppercase", marginBottom: 4}}>Khoản chi lớn nhất</div>
          <div style={{fontSize: 14, fontWeight: 800, color: "#1e293b"}}>{fmt(Math.max(...expenses.map(e => e.amount), 0), currency)}</div>
        </div>
        <div style={{background: "#f8fafc", padding: 10, borderRadius: 12}}>
          <div style={{fontSize: 10, color: "#64748b", fontWeight: 700, textTransform: "uppercase", marginBottom: 4}}>TB mỗi khoản chi</div>
          <div style={{fontSize: 14, fontWeight: 800, color: "#1e293b"}}>{fmt(expenses.length ? totalSpend / expenses.length : 0, currency)}</div>
        </div>
      </div>
    </Card>
  );
}

function EmailSettingsModal({ prefs, onUpdate, onClose }: { prefs: UserPrefs, onUpdate: (p: Partial<UserPrefs>) => void, onClose: () => void }) {
  return (
    <Modal onClose={onClose}>
      <SecTitle icon="📨" title="Thông báo Email" color="#059669" />
      <div style={{display: "flex", flexDirection: "column", gap: 10, marginTop: 10}}>
         {[
           { id: "emailOnPayment", label: "Có người trả tiền", desc: "Nhận mail khi có thành viên thanh toán trong nhóm" },
           { id: "emailOnDebtReminder", label: "Nhắc nợ", desc: "Nhận mail khi có người yêu cầu bạn trả tiền" },
           { id: "emailOnAddedToGroup", label: "Được thêm vào nhóm", desc: "Nhận mail khi bạn trở thành thành viên nhóm mới" },
           { id: "emailOnAddedAsFriend", label: "Kết bạn mới", desc: "Nhận mail khi ai đó lưu bạn vào danh sách bạn" },
           { id: "emailOnMonthlyReport", label: "Báo cáo tháng", desc: "Bản tin tổng hợp chi tiêu cuối mỗi tháng" }
         ].map((item) => (
           <div key={item.id} style={{display:"flex", alignItems:"center", justifyContent:"space-between", padding:"12px 0", borderBottom:"1px solid #f1f5f9"}}>
              <div style={{flex:1, marginRight:12}}>
                 <div style={{fontSize:14, fontWeight:600, color:"#1e293b", marginBottom: 2}}>{item.label}</div>
                 <div style={{fontSize:11, color:"#64748b"}}>{item.desc}</div>
              </div>
              <div 
                onClick={() => onUpdate({ [item.id]: !((prefs as any)[item.id]) })}
                style={{
                  width: 44, height: 24, borderRadius: 12, background: (prefs as any)[item.id] ? "#059669" : "#e2e8f0",
                  position: "relative", cursor: "pointer", transition: "0.2s"
                }}
              >
                 <div style={{
                   width: 18, height: 18, borderRadius: "50%", background: "#fff",
                   position: "absolute", top: 3, left: (prefs as any)[item.id] ? 23 : 3,
                   transition: "0.2s", boxShadow: "0 2px 4px rgba(0,0,0,0.1)"
                 }}/>
              </div>
           </div>
         ))}
      </div>
      <Btn onClick={onClose} style={{width: "100%", marginTop: 20}}>Xong</Btn>
    </Modal>
  );
}

function ReceiptScannerView({ groups, onAddExpense, currency = "đ" }: { groups: Group[], onAddExpense: (groupId: string, e: Expense) => void, currency?: string }) {
  const [step, setStep] = useState(1);
  const [groupId, setGroupId] = useState("");
  const [imageStr, setImageStr] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [items, setItems] = useState<ReceiptItem[]>([]);
  const [desc, setDesc] = useState("Hóa đơn");
  const [payers, setPayers] = useState<Record<string, number>>({});

  const group = groups.find(g => g.id === groupId);
  const members = group?.members || [];

  const handleImage = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      setImageStr(ev.target?.result as string);
      setStep(2);
    };
    reader.readAsDataURL(file);
  };

  const scanReceipt = async () => {
    if(!imageStr) return;
    setIsScanning(true);
    try {
      const base64Data = imageStr.split(",")[1];
      const mimeType = imageStr.substring(imageStr.indexOf(":")+1, imageStr.indexOf(";"));
      
      const response = await ai.models.generateContent({
        model: "gemini-3.1-pro-preview",
        contents: {
          parts: [
            { inlineData: { data: base64Data, mimeType } },
            { text: "Extract receipt items and prices. Return a JSON array of objects. Format: [{ name: 'item name', price: 1000 }]. No markdown, just JSON." }
          ]
        },
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                name: { type: Type.STRING },
                price: { type: Type.NUMBER }
              }
            }
          }
        }
      });
      
      const text = response.text || "[]";
      const parsed = JSON.parse(text);
      setItems(parsed.map((p: any) => ({ ...p, assignedTo: [] })));
      if (members.length > 0) setPayers({ [members[0]]: parsed.reduce((s:number,it:any)=>s+(it.price||0), 0) });
      setStep(3);
    } catch(err) {
      console.error(err);
      alert("Oops! Quét hoá đơn thất bại.");
    } finally {
      setIsScanning(false);
    }
  };

  const toggleAssign = (itemIdx: number, memberName: string) => {
    const newItems = [...items];
    const it = newItems[itemIdx];
    if (it.assignedTo.includes(memberName)) {
      it.assignedTo = it.assignedTo.filter(m => m !== memberName);
    } else {
      it.assignedTo.push(memberName);
    }
    setItems(newItems);
  };

  const total = items.reduce((s, it) => s + (it.price || 0), 0);

  const save = () => {
    if(!group) return;
    onAddExpense(group.id, {
      id: String(Date.now()),
      desc,
      amount: total,
      payers,
      splitMode: "itemized",
      splits: {},
      ts: Date.now(),
      items
    });
    setStep(1); setImageStr(null); setGroupId(""); setItems([]);
  };

  const videoRef = useRef<HTMLVideoElement>(null);
  const [isCameraLive, setIsCameraLive] = useState(false);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      setCameraStream(stream);
      setIsCameraLive(true);
    } catch (err) {
      console.error("Camera error:", err);
      const errorMessage = err instanceof Error ? err.message : String(err);
      
      if ((err instanceof DOMException && err.name === "NotAllowedError") || 
          errorMessage.includes("Permission") || 
          errorMessage.includes("NotAllowedError")) {
        alert("Bạn đã từ chối hoặc hủy quyền truy cập camera. Vui lòng cấp quyền trong cài đặt trình duyệt để tiếp tục.");
      } else {
        alert("Không thể mở camera. Vui lòng kiểm tra quyền truy cập. Thử mở ứng dụng trong thẻ mới (Open in new tab).");
      }
    }
  };

  useEffect(() => {
    if (isCameraLive && videoRef.current && cameraStream) {
      videoRef.current.srcObject = cameraStream;
      videoRef.current.onloadedmetadata = () => {
        videoRef.current?.play().catch(e => console.error("Play error:", e));
      };
    }
  }, [isCameraLive, cameraStream]);

  const stopCamera = () => {
    if (cameraStream) {
      cameraStream.getTracks().forEach(track => track.stop());
    }
    setIsCameraLive(false);
    setCameraStream(null);
  };

  const capturePhoto = () => {
    if (videoRef.current) {
      const canvas = document.createElement("canvas");
      canvas.width = videoRef.current.videoWidth;
      canvas.height = videoRef.current.videoHeight;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);
        setImageStr(canvas.toDataURL("image/jpeg"));
        setStep(2);
        stopCamera();
      }
    }
  };

  useEffect(() => {
    return () => stopCamera();
  }, []);

  if (groups.length === 0) {
    return (
      <div style={{padding: "20px 14px", paddingBottom: 100, maxWidth: 500, margin: "0 auto", textAlign: "center"}}>
        <SecTitle icon="📷" title="Quét Hóa Đơn AI" color="#fff" textColor="#fff" />
        <div style={{padding: 40, color: "#1a4d53", fontSize: 16, fontWeight: 500, background: "rgba(255,255,255,0.2)", borderRadius: 16, marginTop: 20}}>
          Bạn cần tham gia ít nhất 1 nhóm để quét hóa đơn.
        </div>
      </div>
    );
  }

  return (
    <div style={{padding: "20px 14px", paddingBottom: 100, maxWidth: 500, margin: "0 auto"}}>
      <SecTitle icon="📷" title="Quét Hóa Đơn AI" color="#ec4899" />
      
      {step === 1 && (
        <Card>
          <div style={{fontWeight: 700, fontSize: 13, marginBottom: 10, color: "#0b565e"}}>Chọn nhóm thanh toán:</div>
          <select value={groupId} onChange={e=>setGroupId(e.target.value)} style={{width: "100%", padding: 10, borderRadius: 10, border: "2px solid rgba(11,86,94,0.2)", marginBottom: 20, outline: "none", color: "#0b565e"}}>
            <option value="">-- Chọn nhóm --</option>
            {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>

          {groupId && !isCameraLive && (
             <div style={{display: "flex", flexDirection: "column", gap: 10}}>
                <button onClick={startCamera} style={{display: "flex", alignItems: "center", justifyContent: "center", gap: 10, padding: 15, background: "linear-gradient(135deg,#0b565e,#1a4d53)", border: "none", color: "#fff", borderRadius: 12, cursor: "pointer", fontWeight: 700}}>
                   <Camera size={28} />
                   <span style={{ fontSize: 14 }}>Máy ảnh (Chụp AI)</span>
                </button>
                <label style={{display: "flex", alignItems: "center", justifyContent: "center", gap: 10, padding: 15, background: "rgba(255,255,255,0.4)", color: "#0b565e", border: "2px dashed rgba(11,86,94,0.3)", borderRadius: 12, cursor: "pointer", fontWeight: 700}}>
                   <Upload size={28} />
                   <span style={{ fontSize: 14 }}>Tải ảnh lên</span>
                   <input type="file" accept="image/*" onChange={handleImage} style={{display: "none"}} />
                </label>
             </div>
          )}

          {isCameraLive && (
            <div style={{position: "fixed", inset: 0, zIndex: 9999, background: "#000", display: "flex", flexDirection: "column"}}>
              <div style={{padding: "20px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", background: "rgba(0,0,0,0.5)", position: "absolute", top: 0, left: 0, right: 0, zIndex: 10}}>
                <div style={{color: "#fff", fontWeight: 700, fontSize: 18}}>Chụp hóa đơn</div>
                <button onClick={stopCamera} style={{background: "rgba(255,255,255,0.2)", border: "none", borderRadius: "50%", width: 36, height: 36, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer"}}>✕</button>
              </div>
              <div style={{flex: 1, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", position: "relative"}}>
                <video ref={videoRef} autoPlay playsInline muted style={{width: "100%", aspectRatio: "1", objectFit: "cover", display: "block"}} />
                {/* Guide frame */}
                <div style={{position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%)", width: "90%", aspectRatio: "1", border: "2px dashed rgba(255,255,255,0.5)", borderRadius: 20, pointerEvents: "none"}}></div>
              </div>
              <div style={{padding: "30px 20px", background: "#000", display: "flex", justifyContent: "center"}}>
                <button onClick={capturePhoto} style={{width: 70, height: 70, borderRadius: "50%", border: "4px solid #fff", background: "#ec4899", cursor: "pointer", boxShadow: "0 4px 15px rgba(236,72,153,0.5)"}}></button>
              </div>
            </div>
          )}
        </Card>
      )}

      {step === 2 && imageStr && (
        <Card>
          <div style={{fontWeight: 700, marginBottom: 10}}>Ảnh hóa đơn:</div>
          <img src={imageStr} alt="Bill" style={{width: "100%", borderRadius: 10, marginBottom: 15, maxHeight: 300, objectFit: "contain", background: "#f8fafc"}} />
          <Btn onClick={scanReceipt} disabled={isScanning} color="linear-gradient(135deg,#ec4899,#f43f5e)" style={{width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 10}}>
             {isScanning ? <Loader2 size={18} className="animate-spin" /> : <Receipt size={18} />}
             {isScanning ? "AI đang phân tích..." : "Quét bằng AI"}
          </Btn>
          {!isScanning && <Btn onClick={() => setStep(1)} color="#e2e8f0" style={{width: "100%", marginTop: 10, color: "#475569"}}>Hủy</Btn>}
        </Card>
      )}

      {step === 3 && (
        <div style={{animation: "fadeIn 0.3s"}}>
          <Card style={{marginBottom: 10}}>
            <Input placeholder="Mô tả hóa đơn" value={desc} onChange={(e: any) => setDesc(e.target.value)} style={{marginBottom: 10}} />
            <div style={{display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px", background: "#fdf2f8", borderRadius: 10, color: "#be185d", fontWeight: 800}}>
              <span>Tổng cộng:</span>
              <span style={{fontSize: 18}}>{fmt(total, currency)}</span>
            </div>
          </Card>

          <Card style={{marginBottom: 10}}>
            <div style={{fontWeight: 700, marginBottom: 10}}>Ai là người trả tiền?</div>
            <div style={{ display: "flex", gap: 6, marginBottom: 10, overflowX: "auto", paddingBottom: 4 }}>
              <button 
                onClick={() => setPayers({ [members[0]]: total })} 
                style={{ background: payers[members[0]] === total ? "#ec4899" : "#f1f5f9", color: payers[members[0]] === total ? "#fff" : "#64748b", border: "none", borderRadius: 8, padding: "6px 12px", fontSize: 11, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" }}
              >
                🙋 Bạn trả hết
              </button>
              <button 
                onClick={() => {
                  const share = total / members.length;
                  const p: any = {};
                  members.forEach(m => p[m] = share);
                  setPayers(p);
                }} 
                style={{ background: Object.keys(payers).length > 1 ? "#ec4899" : "#f1f5f9", color: Object.keys(payers).length > 1 ? "#fff" : "#64748b", border: "none", borderRadius: 8, padding: "6px 12px", fontSize: 11, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" }}
              >
                🤝 Cả nhóm cùng trả
              </button>
            </div>
          </Card>

          <Card style={{marginBottom: 10}}>
            <div style={{fontWeight: 700, marginBottom: 10}}>Chia theo món:</div>
            {items.map((it, idx) => (
              <div key={idx} style={{marginBottom: 12, padding: "10px", border: "1px solid #e2e8f0", borderRadius: 10}}>
                <div style={{display: "flex", justifyContent: "space-between", fontWeight: 600, marginBottom: 8}}>
                  <span>{it.name}</span>
                  <span style={{color: "#ec4899"}}>{fmt(it.price || 0, currency)}</span>
                </div>
                <div style={{display: "flex", flexWrap: "wrap", gap: 6}}>
                  {members.map(m => {
                    const isAsg = it.assignedTo.includes(m);
                    return (
                      <button key={m} onClick={() => toggleAssign(idx, m)} style={{padding: "4px 8px", borderRadius: 12, border: `1px solid ${isAsg ? "#ec4899" : "#cbd5e1"}`, background: isAsg ? "#fdf2f8" : "#fff", color: isAsg ? "#be185d" : "#64748b", fontSize: 11, fontWeight: 600, cursor: "pointer"}}>
                        {m}
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
          </Card>
          
          <Btn onClick={save} color="linear-gradient(135deg,#ec4899,#f43f5e)" style={{width: "100%"}}>✅ Thêm vào nhóm</Btn>
          <Btn onClick={() => setStep(1)} color="#e2e8f0" style={{width: "100%", marginTop: 10, color: "#475569"}}>Hủy</Btn>
        </div>
      )}
    </div>
  );
}

function GroupView({ group, friends, profile, onUpdate, onDelete, onLeave, onBack, sendInviteEmail }: { group: Group, friends: Friend[], profile: UserProfile | null, onUpdate: (g: Group) => void, onDelete: () => void, onLeave: () => void, onBack: () => void, sendInviteEmail: (email: string, inviterName: string, groupName?: string, inviteCode?: string, groupId?: string) => Promise<boolean> }) {
  const currency = profile?.currency || "đ";
  const [subTab,setSubTab]=useState("home");
  const [selectedBill,setSelectedBill]=useState<Expense | null>(null);
  const [showAddExp,setShowAddExp]=useState(false);
  const [showPay,setShowPay]=useState(false);
  const [showSettings,setShowSettings]=useState(false);

  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [feed, setFeed] = useState<FeedItem[]>([]);

  const members  = group.members||[];
  const currentUserName = profile?.name || "";

  const resolveMemberDisplay = (name: string) => {
    const idx = members.indexOf(name);
    const uid = group.memberUids?.[idx];
    const isMe = uid === auth.currentUser?.uid;
    const isLeader = uid === group.leaderUid || name === group.leader;
    
    let finalName = name;
    if (name === "Bạn" || name === "Thành viên" || name === "Trưởng nhóm") {
      if (isMe && currentUserName && currentUserName !== name) {
        finalName = currentUserName;
      } else if (isLeader && group.leader && group.leader !== name) {
        finalName = group.leader;
      }
    }
    
    return { name: finalName || "Thành viên", isMe, isLeader };
  };

  const memberAvatars = useMemo(() => {
    const map: Record<string, string> = {};
    members.forEach(m => {
      const { isMe } = resolveMemberDisplay(m);
      let av = isMe ? (profile?.avatar || group.memberDetails?.[m]?.avatar) : group.memberDetails?.[m]?.avatar;
      if (!av) {
        const friend = friends.find(f => f.name === m);
        if (friend?.avatar) av = friend.avatar;
      }
      if (av) map[m] = av;
    });
    return map;
  }, [members, profile?.avatar, group.memberDetails, friends, group.memberUids, auth.currentUser?.uid]);

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
      await addDoc(collection(db, "groups", group.id, "expenses"), clean({ 
        ...data, 
        createdBy: auth.currentUser?.uid,
        memberDetails: group.memberDetails || {} 
      }));
      await addDoc(collection(db, "groups", group.id, "feed"), {
        type: "expense",
        text: `${mainPayer} đã thêm "${exp.desc}" — ${fmt(exp.amount, currency)}`,
        ts: Date.now(),
        icon: "🧾",
        name: mainPayer
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `groups/${group.id}/expenses`);
    }
  };



  const addPayment = async (p: any) => {
    try {
      const { id, ...data } = p;
      await addDoc(collection(db, "groups", group.id, "payments"), clean({ ...data, createdBy: auth.currentUser?.uid }));
      await addDoc(collection(db, "groups", group.id, "feed"), {
        type: "paid",
        text: `${p.from} đã trả ${fmt(p.amount, currency)} cho ${p.to}${p.note?" · "+p.note:""}`,
        ts: p.ts,
        icon: "✅",
        name: p.from
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, "payments");
    }
  };

  const { total, balances, transactions } = useMemo(() => computeGroupBalances({ ...group, expenses, payments }), [group, expenses, payments]);

  const [viewingMember, setViewingMember] = useState<string | null>(null);

  const memberStats = useMemo(() => {
    if (!viewingMember) return null;
    const m = viewingMember;
    
    let spentByMember = 0;
    let spentForMe = 0;
    let paidByMember = 0;
    let receivedByMember = 0;

    expenses.forEach(e => {
        if (e.payers[m]) {
            spentByMember += e.payers[m];
            
            // Calculate how much of this was for me
            const { isMe: isMeViewing } = resolveMemberDisplay(m);
            const { isMe: iAmPaying } = resolveMemberDisplay(currentUserName); 
            
            const parts = e.participants || [];
            if (parts.includes(currentUserName) && m !== currentUserName) {
                // If they paid and I am a participant, calculate my share in their payment
                // Simple equal split for this breakdown
                spentForMe += e.payers[m] / parts.length;
            }
        }
    });

    payments.forEach(p => {
        if (p.from === m) paidByMember += p.amount;
        if (p.to === m) receivedByMember += p.amount;
    });

    const netBalance = balances[m] || 0;

    return { spentByMember, spentForMe, paidByMember, receivedByMember, netBalance };
  }, [viewingMember, expenses, payments, balances, currentUserName]);

  const subtabs=[{id:"home",icon:"🏠"},{id:"expenses",icon:"🧾"},{id:"stats",icon:"📊"},{id:"members",icon:"👥"},{id:"feed",icon:"🔔"}];

  return (
    <div style={{display:"flex",flexDirection:"column",height:"100%"}}>
      {selectedBill && (
        <BillDetailModal 
          bill={selectedBill} 
          group={group} 
          memberAvatars={memberAvatars}
          onClose={() => setSelectedBill(null)}
          currency={currency}
        />
      )}
      {showAddExp&&<AddExpenseModal members={members} memberAvatars={memberAvatars} onAdd={addExpense} onClose={()=>setShowAddExp(false)} currency={currency}/>}
      {showPay&&<PayModal members={members} memberAvatars={memberAvatars} transactions={transactions} onPay={addPayment} onClose={()=>setShowPay(false)} currency={currency}/>}
      {showSettings&&<GroupSettingsModal group={group} friends={friends} currentUser={auth.currentUser?.displayName || ""} memberAvatars={memberAvatars} onClose={()=>setShowSettings(false)} onUpdate={onUpdate} onLeave={onLeave} onDelete={onDelete} sendInviteEmail={sendInviteEmail}/>}

      <div style={{background:"linear-gradient(135deg, #0b565e, #147f87)",padding:"12px 16px 0",flexShrink:0}}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
          <button onClick={onBack} style={{background:"rgba(255,255,255,0.2)", border:"none", borderRadius:8, width:32, height:32, color:"#fff", fontSize:24, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center"}}>‹</button>
          <div style={{fontSize:32}}>{group.emoji}</div>
          <div style={{flex:1}}>
            <div style={{color:"#fff",fontWeight:800,fontSize:17}}>{group.name}</div>
            <div style={{color:"rgba(255,255,255,0.9)",fontSize:11,fontWeight:600}}>{members.length} thành viên · {total > 0 ? fmt(total, currency) : "Chưa chi"}</div>
          </div>
          <button onClick={()=>setShowSettings(true)} style={{background:"rgba(255,255,255,.2)",border:"none",borderRadius:9,width:34,height:34,color:"#fff",fontSize:16,cursor:"pointer"}}>⚙️</button>
        </div>
        <div style={{display:"flex",gap:2}}>
          {subtabs.map(t=>(
            <button key={t.id} onClick={()=>setSubTab(t.id)} style={{flex:1,padding:"8px 4px",border:"none",background:"none",color:subTab===t.id?"#fff":"rgba(255,255,255,.6)",fontSize:18,cursor:"pointer",borderBottom:subTab===t.id?"2px solid #fff":"2px solid transparent",transition:"color 0.2s"}}>{t.icon}</button>
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
            <Card style={{padding:"14px 8px"}}>
              <SecTitle icon="🔄" title="Ai đang nợ ai?" color="#d97706"/>
              {transactions.length===0?(
                <div style={{textAlign:"center",padding:"12px 0",color:"#94a3b8",fontSize:13}}>{expenses.length===0?"Chưa có hóa đơn nào":"🎉 Mọi người đã huề!"}</div>
                ):transactions.map((t,i)=>{
                  const fromRes = resolveMemberDisplay(t.from);
                  const toRes = resolveMemberDisplay(t.to);
                  const fromAvatar = fromRes.isMe ? (profile?.avatar || group.memberDetails?.[t.from]?.avatar) : group.memberDetails?.[t.from]?.avatar;
                  
                  return (
                    <div key={i} style={{display:"flex",alignItems:"center",gap:4,padding:"9px 0",borderBottom:i<transactions.length-1?"1px solid #f3f4f6":"none"}}>
                      <Av name={fromRes.name} size={32} ci={members.indexOf(t.from)} avatar={fromAvatar}/>
                      <div style={{flex:1,fontSize:13,fontWeight:700}}>
                        <span style={{color:"#dc2626", display: "inline-flex", alignItems: "center", gap: 3}}>
                          {fromRes.name}
                          {fromRes.isLeader && <span style={{fontSize: 9, padding: "1px 4px", background: "#fef3c7", color: "#d97706", borderRadius: 4, fontWeight: 800, marginLeft: 2}}>TRƯỞNG NHÓM</span>}
                          {fromRes.isMe && <span style={{fontWeight: 400, fontSize: 11, color: "#94a3b8"}}>(Bạn)</span>}
                        </span> 
                        <span style={{color:"#fff", fontWeight: 900, padding: "2px 8px", background: "#ef4444", borderRadius: 12, fontSize: 10, margin: "0 4px"}}>NỢ</span> 
                        <span style={{color:"#059669", display: "inline-flex", alignItems: "center", gap: 3}}>
                          {toRes.name}
                          {toRes.isLeader && <span style={{fontSize: 9, padding: "1px 4px", background: "#fef3c7", color: "#d97706", borderRadius: 4, fontWeight: 800, marginLeft: 2}}>TRƯỞNG NHÓM</span>}
                          {toRes.isMe && <span style={{fontWeight: 400, fontSize: 11, color: "#94a3b8"}}>(Bạn)</span>}
                        </span>
                      </div>
                      <span style={{fontWeight:800,fontSize:14,color:"#059669"}}>{fmt(t.amount, currency)}</span>
                    </div>
                  );
                })}
            </Card>
          </>
        )}

        {subTab==="expenses"&&(
          <>
            {[...expenses, ...(payments || [])]
              .sort((a, b) => (b.ts || 0) - (a.ts || 0))
              .map((item) => {
                const isExpense = 'desc' in item;
                if (isExpense) {
                  const e = item as Expense;
                  return (
                    <Card key={e.id} onClick={()=>setSelectedBill(e)} style={{padding:"12px 8px",marginBottom:8, cursor: "pointer"}}>
                      <div style={{display:"flex",alignItems:"center",gap:7}}>
                        <div style={{width:38,height:38,borderRadius:11,background:"#ede9fe",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>🧾</div>
                        <div style={{flex:1}}>
                          <div style={{fontWeight:800,fontSize:14}}>{e.desc}</div>
                          <div style={{fontSize:11,color:"#059669",fontWeight:600}}>
                            {Object.keys(e.payers).filter(k => (e.items ? e.payers[k] : (e.payers[k] || 0)) > 0).join(", ")}
                          </div>
                        </div>
                        <div style={{textAlign:"right"}}><div style={{fontWeight:800,fontSize:13,color:"#db2777"}}>{fmt(e.amount, currency)}</div></div>
                      </div>
                    </Card>
                  );
                } else {
                  const p = item as Payment;
                  return (
                    <Card key={p.id} style={{padding:"12px 8px",marginBottom:8, border: "1px solid #10b981", background: "#f0fdf4"}}>
                      <div style={{display:"flex",alignItems:"center",gap:7}}>
                        <div style={{width:38,height:38,borderRadius:11,background:"#dcfce7",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>💸</div>
                        <div style={{flex:1}}>
                          <div style={{fontWeight:800,fontSize:14}}>{p.from} trả {p.to}</div>
                          <div style={{fontSize:11,color:"#059669",fontWeight:600}}>{p.note || "Xác nhận trả nợ"}</div>
                        </div>
                        <div style={{textAlign:"right"}}><div style={{fontWeight:800,fontSize:13,color:"#059669"}}>{fmt(p.amount, currency)}</div></div>
                      </div>
                    </Card>
                  );
                }
              })}
            {(expenses.length === 0 && (!payments || payments.length === 0)) && (
              <div style={{textAlign:"center", padding: "60px 20px", color: "#fff"}}>
                <div style={{fontSize: 64, marginBottom: 20, filter: "drop-shadow(0 0 20px rgba(255,255,255,0.3))"}}>🧾</div>
                <div style={{fontWeight: 900, fontSize: 20, marginBottom: 8, letterSpacing: -0.5}}>Chưa có hoạt động nào</div>
                <div style={{fontSize: 14, opacity: 0.9, maxWidth: 200, margin: "0 auto", lineHeight: 1.5}}>Các khoản chi và thanh toán sẽ hiện ở đây</div>
              </div>
            )}
          </>
        )}

        {subTab==="stats"&&(
          <GroupStats group={group} expenses={expenses} payments={payments} balances={balances} transactions={transactions} currency={currency}/>
        )}

        {subTab==="members"&&(
          <div>
            <div style={{ background: "linear-gradient(135deg, #0b565e, #147f87)", borderRadius: 20, padding: 24, color: "#fff", marginBottom: 20, boxShadow: "0 10px 25px -5px rgba(11, 86, 94, 0.4)" }}>
              <div style={{ fontSize: 40, marginBottom: 8 }}>👥</div>
              <div style={{ fontSize: 24, fontWeight: 900 }}>{members.length} Thành viên</div>
              <div style={{ fontSize: 13, opacity: 0.9, fontWeight: 600 }}>Những người đang cùng bạn chia sẻ mọi thứ</div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {members.map((m, i) => {
                const { isMe, isLeader } = resolveMemberDisplay(m);
                let finalAvatar = isMe ? (profile?.avatar || group.memberDetails?.[m]?.avatar) : group.memberDetails?.[m]?.avatar;
                
                // Fallback to friends list avatar if missing
                if (!finalAvatar) {
                  const friend = friends.find(f => f.name === m);
                  if (friend?.avatar) finalAvatar = friend.avatar;
                }
                
                return (
                  <Card key={i} onClick={() => setViewingMember(m)} style={{ padding: "12px 14px", border: isLeader ? "1.5px solid #ddd6fe" : "none", cursor: "pointer" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <Av name={m} size={42} ci={i} avatar={finalAvatar} />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 800, fontSize: 15, color: "#1e293b", display: "flex", alignItems: "center", gap: 6 }}>
                          {m}
                          {isLeader && <span style={{ background: "#ecfdf5", color: "#059669", fontSize: 9, padding: "2px 6px", borderRadius: 10, fontWeight: 900 }}>TRƯỞNG NHÓM</span>}
                        </div>
                      </div>
                      <div style={{ fontSize: 18, color: "#94a3b8" }}>›</div>
                    </div>
                  </Card>
                );
              })}
            </div>

            {viewingMember && memberStats && (
              <Modal onClose={() => setViewingMember(null)}>
                <div style={{ textAlign: "center", marginBottom: 20 }}>
                  <Av name={viewingMember} size={80} style={{ margin: "0 auto" }} avatar={
                    (() => {
                      const { isMe } = resolveMemberDisplay(viewingMember);
                      let av = isMe ? (profile?.avatar || group.memberDetails?.[viewingMember]?.avatar) : group.memberDetails?.[viewingMember]?.avatar;
                      if (!av) {
                        const friend = friends.find(f => f.name === viewingMember);
                        if (friend?.avatar) av = friend.avatar;
                      }
                      return av;
                    })()
                  } />
                  <div style={{ fontWeight: 900, fontSize: 24, marginTop: 12 }}>{viewingMember}</div>
                  {resolveMemberDisplay(viewingMember).isLeader && <div style={{ fontSize: 11, fontWeight: 800, color: "#059669", textTransform: "uppercase", marginTop: 4 }}>Trưởng nhóm</div>}
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 20 }}>
                  <div style={{ background: "#f8fafc", padding: 14, borderRadius: 16, textAlign: "center" }}>
                    <div style={{ fontSize: 10, fontWeight: 800, color: "#64748b", textTransform: "uppercase", marginBottom: 4 }}>Đã chi cho nhóm</div>
                    <div style={{ fontWeight: 800, fontSize: 16, color: "#0f172a" }}>{fmt(memberStats.spentByMember, currency)}</div>
                  </div>
                  <div style={{ background: "#f8fafc", padding: 14, borderRadius: 16, textAlign: "center" }}>
                    <div style={{ fontSize: 10, fontWeight: 800, color: "#64748b", textTransform: "uppercase", marginBottom: 4 }}>Đã chi cho bạn</div>
                    <div style={{ fontWeight: 800, fontSize: 16, color: "#059669" }}>{fmt(memberStats.spentForMe, currency)}</div>
                  </div>
                  <div style={{ background: "#f8fafc", padding: 14, borderRadius: 16, textAlign: "center" }}>
                    <div style={{ fontSize: 10, fontWeight: 800, color: "#64748b", textTransform: "uppercase", marginBottom: 4 }}>Đã thanh toán</div>
                    <div style={{ fontWeight: 800, fontSize: 16, color: "#2563eb" }}>{fmt(memberStats.paidByMember, currency)}</div>
                  </div>
                  <div style={{ background: "#f8fafc", padding: 14, borderRadius: 16, textAlign: "center" }}>
                    <div style={{ fontSize: 10, fontWeight: 800, color: "#64748b", textTransform: "uppercase", marginBottom: 4 }}>Đã nhận về</div>
                    <div style={{ fontWeight: 800, fontSize: 16, color: "#ea580c" }}>{fmt(memberStats.receivedByMember, currency)}</div>
                  </div>
                </div>

                <div style={{ background: memberStats.netBalance >= 0 ? "#ecfdf5" : "#fef2f2", padding: 16, borderRadius: 16, textAlign: "center", border: `1.5px solid ${memberStats.netBalance >= 0 ? "#059669" : "#dc2626"}` }}>
                  <div style={{ fontSize: 11, fontWeight: 800, color: memberStats.netBalance >= 0 ? "#059669" : "#dc2626", textTransform: "uppercase", marginBottom: 6 }}>Tổng chênh lệch</div>
                  <div style={{ fontWeight: 900, fontSize: 24, color: memberStats.netBalance >= 0 ? "#059669" : "#dc2626" }}>
                    {memberStats.netBalance > 0 ? "+" : ""}{fmt(memberStats.netBalance, currency)}
                  </div>
                  <div style={{ fontSize: 11, color: memberStats.netBalance >= 0 ? "#059669" : "#dc2626", marginTop: 4, opacity: 0.8 }}>
                    {memberStats.netBalance >= 0 ? "Được nhận lại từ nhóm" : "Cần đóng thêm cho nhóm"}
                  </div>
                </div>

                {(group.memberDetails?.[viewingMember]?.phone || group.memberDetails?.[viewingMember]?.email) && (
                  <div style={{ marginTop: 20, borderTop: "1px solid #f1f5f9", paddingTop: 15 }}>
                    <div style={{ fontSize: 11, fontWeight: 800, color: "#94a3b8", textTransform: "uppercase", marginBottom: 10 }}>Thông tin liên hệ</div>
                    {group.memberDetails?.[viewingMember]?.phone && (
                      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, fontSize: 14, color: "#1e293b" }}>
                        <span style={{ fontSize: 16 }}>📞</span> {group.memberDetails[viewingMember].phone}
                      </div>
                    )}
                    {group.memberDetails?.[viewingMember]?.email && (
                      <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 14, color: "#1e293b" }}>
                        <span style={{ fontSize: 16 }}>📧</span> {group.memberDetails[viewingMember].email}
                      </div>
                    )}
                  </div>
                )}
                
                <Btn onClick={() => setViewingMember(null)} style={{ width: "100%", marginTop: 24, background: "#f1f5f9", color: "#64748b" }}>Đóng</Btn>
              </Modal>
            )}

            <Card style={{ marginTop: 20, background: "#f8fafc", border: "1px dashed #cbd5e1", textAlign: "center", padding: "20px" }}>
              <div style={{ fontSize: 13, color: "#64748b", marginBottom: 12 }}>Muốn thêm người mới vào nhóm?</div>
              <Btn onClick={() => setShowSettings(true)} style={{ background: "#059669", fontSize: 13 }}>
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

function FriendActionModal({ friend, groups, onClose, onPay, currency = "đ" }: { friend: Friend, groups: Group[], onClose: () => void, onPay: (group: Group) => void, currency?: string }) {
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
    const body = encodeURIComponent(`Chào ${friend.name},\n\nBạn đang có khoản nợ/dư là ${fmt(Math.abs(friendBalances.netBalance), currency)} trong ứng dụng HappyShare.\n\nHãy kiểm tra và thanh toán nhé!\n\nTrân trọng.`);
    window.location.href = `mailto:${friend.email}?subject=${subject}&body=${body}`;
  };

  return (
    <Modal onClose={onClose}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
        <Av name={friend.name} size={54} ci={0} avatar={friend.avatar} />
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 800, fontSize: 18, color: "#0b565e" }}>{friend.name}</div>
          <div style={{ fontSize: 13, color: "#2d666d" }}>{friendBalances.sharedGroupsCount} nhóm chung</div>
        </div>
      </div>

      {Math.abs(Math.round(friendBalances.netBalance)) >= 1 && (
        <div style={{ background: friendBalances.netBalance >= 0 ? "#f0fdf4" : "#fef2f2", borderRadius: 16, padding: "16px", marginBottom: 20, textAlign: "center", border: `2px solid ${friendBalances.netBalance >= 0 ? "#bbf7d0" : "#fecaca"}` }}>
          <div style={{ fontSize: 13, fontWeight: 800, color: friendBalances.netBalance >= 0 ? "#16a34a" : "#dc2626", textTransform: "uppercase", marginBottom: 6 }}>
            {friendBalances.netBalance >= 0 ? "💰 ĐANG DƯ" : "🔴 ĐANG NỢ"}
          </div>
          <div style={{ fontSize: 24, fontWeight: 900, color: friendBalances.netBalance >= 0 ? "#16a34a" : "#dc2626" }}>
            {fmt(Math.abs(friendBalances.netBalance))}
          </div>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 20 }}>
        <Btn onClick={sendReminder} disabled={!friend.email || Math.abs(Math.round(friendBalances.netBalance)) < 1} style={{ background: (friend.email && Math.abs(Math.round(friendBalances.netBalance)) >= 1) ? "#2563eb" : "#cbd5e1" }}>
          📧 {friend.email ? "Nhắc nợ" : "Không có mail"}
        </Btn>
        <Btn onClick={() => {
           const g = friendBalances.groupDetails[0]?.group;
           if(g) onPay(g);
        }} disabled={friendBalances.groupDetails.length === 0} color="#059669">
          💸 Thanh toán
        </Btn>
      </div>

      <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 10, color: "#0b565e" }}>Chi tiết từng nhóm:</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {friendBalances.groupDetails.map((gd, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, background: "rgba(255,255,255,0.4)", padding: "10px 12px", borderRadius: 12, border: "1px solid rgba(11,86,94,0.1)" }}>
            <span style={{ fontSize: 20 }}>{gd.emoji}</span>
            <span style={{ flex: 1, fontSize: 13, fontWeight: 700, color: "#0b565e" }}>{gd.name}</span>
            {Math.abs(Math.round(gd.balance)) >= 1 && (
              <span style={{ fontWeight: 800, fontSize: 13, color: gd.balance >= 0 ? "#059669" : "#dc2626" }}>
                {gd.balance >= 0 ? "+" : ""}{fmt(gd.balance, currency)}
              </span>
            )}
          </div>
        ))}
        {friendBalances.groupDetails.length === 0 && <div style={{ textAlign: "center", color: "#2d666d", fontSize: 12, padding: 10 }}>Không có nhóm chung nào.</div>}
      </div>
    </Modal>
  );
}

function FriendsView({ friends, groups, onAddFriend, onRemoveFriend, onPayClick, currency = "đ" }: { friends: Friend[], groups: Group[], onAddFriend: (f: Friend) => void, onRemoveFriend: (id: string) => void, onPayClick: (g: Group) => void, currency?: string }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [selectedFriend, setSelectedFriend] = useState<Friend | null>(null);
  const [activeTab, setActiveTab] = useState<"list" | "pending">("list");
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const add = () => {
    if (!name.trim()) return;
    if (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      alert("Email không hợp lệ!");
      return;
    }
    const status = email.trim() ? 'pending' : 'accepted';
    onAddFriend({ name: name.trim(), email: email.trim(), status, createdAt: Date.now() });
    setName("");
    setEmail("");
    if (status === 'pending') setActiveTab("pending");
  };

  const acceptedFriends = friends.filter(f => f.status === 'accepted');
  const pendingFriends = friends.filter(f => f.status === 'pending');

  return (
    <div style={{ padding: "12px 14px" }}>
      {selectedFriend && <FriendActionModal friend={selectedFriend} groups={groups} onClose={() => setSelectedFriend(null)} onPay={(g) => { setSelectedFriend(null); onPayClick(g); }} currency={currency} />}
      
      <Card style={{ padding: "18px", marginBottom: 20 }}>
        <SecTitle icon="👥" title="Thêm bạn mới" color="#059669" />
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <Input placeholder="Họ và tên..." value={name} onChange={(e: any) => setName(e.target.value)} />
          <Input placeholder="Địa chỉ email (không bắt buộc)..." value={email} onChange={(e: any) => setEmail(e.target.value)} />
          <div style={{ fontSize: 11, color: "#64748b", marginTop: -4, marginLeft: 4 }}>* Nhập email để gửi lời mời, hoặc để trống để thêm vào danh sách ngay.</div>
          <Btn onClick={add} style={{ marginTop: 4, background: "linear-gradient(135deg,#059669,#34d399)" }}>✨ {email.trim() ? "Gửi lời mời" : "Thêm ngay"}</Btn>
        </div>
      </Card>
      
      {/* TABS */}
      <div style={{ display: "flex", background: "rgba(255,255,255,0.1)", backdropFilter: "blur(8px)", borderRadius: 16, padding: 5, marginBottom: 20, border: "1px solid rgba(255,255,255,0.1)" }}>
        <button 
          onClick={() => setActiveTab("list")}
          style={{ 
            flex: 1, 
            padding: "10px", 
            borderRadius: 12, 
            border: "none", 
            fontSize: 13, 
            fontWeight: 800, 
            cursor: "pointer", 
            transition: "all 0.3s cubic-bezier(0.4, 0, 0.2, 1)", 
            background: activeTab === "list" ? "rgba(255,255,255,0.95)" : "transparent", 
            color: activeTab === "list" ? "#059669" : "rgba(255,255,255,0.8)",
            boxShadow: activeTab === "list" ? "0 4px 12px rgba(0,0,0,0.1)" : "none",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6
          }}
        >
          <span>👥 Bạn bè</span>
          <span style={{ fontSize: 10, background: activeTab === "list" ? "#059669" : "rgba(255,255,255,0.2)", color: "#fff", padding: "1px 6px", borderRadius: 8 }}>{acceptedFriends.length}</span>
        </button>
        <button 
          onClick={() => setActiveTab("pending")}
          style={{ 
            flex: 1, 
            padding: "10px", 
            borderRadius: 12, 
            border: "none", 
            fontSize: 13, 
            fontWeight: 800, 
            cursor: "pointer", 
            transition: "all 0.3s cubic-bezier(0.4, 0, 0.2, 1)", 
            background: activeTab === "pending" ? "rgba(255,255,255,0.95)" : "transparent", 
            color: activeTab === "pending" ? "#059669" : "rgba(255,255,255,0.8)",
            boxShadow: activeTab === "pending" ? "0 4px 12px rgba(0,0,0,0.1)" : "none",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6
          }}
        >
          <span>⏳ Đang chờ</span>
          <span style={{ fontSize: 10, background: activeTab === "pending" ? "#f59e0b" : "rgba(255,255,255,0.2)", color: "#fff", padding: "1px 6px", borderRadius: 8 }}>{pendingFriends.length}</span>
        </button>
      </div>

      {activeTab === "list" ? (
        <>
          {acceptedFriends.map((f, i) => (
            <Card key={f.id || i} onClick={() => setSelectedFriend(f)} style={{ padding: "12px 14px", marginBottom: 7, cursor: "pointer" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <Av name={f.name} size={42} ci={i} avatar={f.avatar} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, fontSize: 14, color: "#0b565e" }}>{f.name}</div>
                  {f.email && <div style={{ fontSize: 11, color: "#2d666d" }}>✉️ {f.email}</div>}
                </div>
                {deletingId === f.id ? (
                  <div style={{ display: "flex", gap: 6 }}>
                    <button 
                      onClick={(e) => { e.stopPropagation(); setDeletingId(null); }} 
                      style={{ background: "#e2e8f0", border: "none", color: "#475569", borderRadius: 8, padding: "6px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer" }}
                    >
                      Hủy
                    </button>
                    <button 
                      onClick={(e) => { e.stopPropagation(); if (f.id) onRemoveFriend(f.id); setDeletingId(null); }} 
                      style={{ background: "#dc2626", border: "none", color: "#fff", borderRadius: 8, padding: "6px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer" }}
                    >
                      Xóa
                    </button>
                  </div>
                ) : (
                  <button 
                    onClick={(e) => { 
                      e.stopPropagation(); 
                      setDeletingId(f.id || null);
                    }} 
                    style={{ background: "#fef2f2", border: "none", color: "#dc2626", borderRadius: 8, width: 32, height: 32, cursor: "pointer", fontWeight: 700, fontSize: 16 }}
                  >
                    ×
                  </button>
                )}
              </div>
            </Card>
          ))}
          {acceptedFriends.length === 0 && <div style={{ textAlign: "center", padding: "40px 20px", color: "#1a4d53", fontSize: 14, fontWeight: 600 }}>Bạn chưa có người bạn nào.</div>}
        </>
      ) : (
        <>
          {pendingFriends.map((f, i) => (
            <Card key={f.id || i} style={{ padding: "12px 14px", marginBottom: 7, opacity: 0.9 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <Av name={f.name} size={42} ci={i + acceptedFriends.length} avatar={f.avatar} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, fontSize: 14, color: "#0b565e" }}>{f.name}</div>
                  <div style={{ fontSize: 11, color: "#2d666d", display: "flex", alignItems: "center", gap: 6 }}>
                    <span>✉️ {f.email}</span>
                  </div>
                </div>
                {deletingId === f.id ? (
                  <div style={{ display: "flex", gap: 6 }}>
                    <button 
                      onClick={(e) => { e.stopPropagation(); setDeletingId(null); }} 
                      style={{ background: "#f1f5f9", border: "none", color: "#0b565e", borderRadius: 8, padding: "6px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer" }}
                    >
                      Bỏ
                    </button>
                    <button 
                      onClick={(e) => { e.stopPropagation(); if (f.id) onRemoveFriend(f.id); setDeletingId(null); }} 
                      style={{ background: "#dc2626", border: "none", color: "#fff", borderRadius: 8, padding: "6px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer" }}
                    >
                      Hủy lời mời
                    </button>
                  </div>
                ) : (
                  <button 
                    onClick={(e) => { 
                      e.stopPropagation(); 
                      setDeletingId(f.id || null);
                    }} 
                    style={{ background: "#fef2f2", border: "none", color: "#dc2626", borderRadius: 8, width: 32, height: 32, cursor: "pointer", fontWeight: 700, fontSize: 16 }}
                  >
                    ×
                  </button>
                )}
              </div>
            </Card>
          ))}
          {pendingFriends.length === 0 && <div style={{ textAlign: "center", padding: "40px 20px", color: "#1a4d53", fontSize: 14, fontWeight: 600 }}>Không có lời mời nào đang chờ.</div>}
        </>
      )}
    </div>
  );
}

function GroupsListView({ groups, friends, onSelectGroup, onCreateGroup, currency = "đ" }: { groups: Group[], friends: Friend[], onSelectGroup: (g: Group) => void, onCreateGroup: (g: Group) => void, currency?: string }) {
  const [showCreate,setShowCreate] = useState(false);
  const [gName,setGName] = useState(""); const [gEmoji,setGEmoji] = useState("🎉");

  const createGroup = () => {
    if(!gName.trim()) {
      alert("Vui lòng nhập tên nhóm!");
      return;
    }
    onCreateGroup({
      id:String(Date.now()),
      name:gName.trim(),
      emoji:gEmoji,
      members:[],
      memberUids:[],
      leader: auth.currentUser?.displayName || "Trưởng nhóm",
      leaderUid: auth.currentUser?.uid || "",
      expenses:[],
      payments:[],
      feed:[{id:String(Date.now()),type:"group",text:`Nhóm "${gName.trim()}" được tạo`,ts:Date.now(),icon:"🎉"}],
      inviteCode:genCode(),
      dueDate:""
    });
    setGName("");setShowCreate(false);
  };

  return (
    <div style={{padding:"12px 14px"}}>
      {showCreate&&(
        <Modal onClose={()=>setShowCreate(false)}>
          <div style={{fontWeight:800,fontSize:16,marginBottom:14}}>🎉 Tạo nhóm mới</div>
          <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:10}}>
            {EMOJIS.map(e=><button key={e} onClick={()=>setGEmoji(e)} style={{width:38,height:38,borderRadius:9,fontSize:20,border:gEmoji===e?"2.5px solid #059669":"2px solid #e2e8f0",background:gEmoji===e?"#f0fdf4":"#fff",cursor:"pointer"}}>{e}</button>)}
          </div>
          <Input placeholder="Tên nhóm..." value={gName} onChange={(e: any)=>setGName(e.target.value)} style={{marginBottom:15}}/>
          <Btn onClick={createGroup} style={{width:"100%", padding:"14px", fontSize: 14}}>✨ Tạo nhóm ngay</Btn>
        </Modal>
      )}

      <div style={{display:"flex",gap:8,marginBottom:12}}>
        <button 
          onClick={() => setShowCreate(true)} 
          style={{flex:1,background:"linear-gradient(135deg,#059669,#34d399)",color:"#fff",border:"none",borderRadius:12,padding:"11px",fontWeight:700,fontSize:13,cursor:"pointer"}}
        >
          ✨ Tạo nhóm
        </button>
      </div>

      {groups.map((g)=>{
        const groupColorIndex = g.id.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
        return(
          <Card key={g.id} onClick={()=>onSelectGroup(g)} style={{padding:"14px 16px",marginBottom:10, transition: "transform 0.2s"}}>
            <div style={{display:"flex",alignItems:"center",gap:14}}>
              <div style={{width:52,height:52,borderRadius:16,background:COLORS[groupColorIndex % COLORS.length] + "15",display:"flex",alignItems:"center",justifyContent:"center",fontSize:30,flexShrink:0}}>
                {g.emoji}
              </div>
              <div style={{flex:1}}>
                <div style={{fontWeight:800,fontSize:15,color:"#0b565e",marginBottom:2}}>{g.name}</div>
                <div style={{fontSize:11,color:"#2d666d",display:"flex",alignItems:"center",gap:5}}>
                  <span style={{background:"rgba(255,255,255,0.4)",padding:"2px 6px",borderRadius:5,fontWeight:600}}>{g.members.length} người</span>
                </div>
              </div>
              <div style={{textAlign:"right",display:"flex",alignItems:"center",gap:8}}>
                <div style={{color:"#cbd5e1",fontSize:20,fontWeight:300}}>›</div>
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

interface UserProfile {
  uid: string;
  name: string;
  avatar: string;
  email: string;
  createdAt: number;
  currency?: string;
}

interface UserPrefs {
  emailOnPayment: boolean;
  emailOnDebtReminder: boolean;
  emailOnAddedToGroup: boolean;
  emailOnAddedAsFriend: boolean;
  emailOnMonthlyReport: boolean;
}

interface GroupInvitation {
  id: string;
  groupId: string;
  groupName: string;
  inviterName: string;
  inviteCode: string;
  email: string;
  status: "pending" | "accepted" | "declined";
  createdAt: string;
}

const DEFAULT_PREFS: UserPrefs = {
  emailOnPayment: true,
  emailOnDebtReminder: true,
  emailOnAddedToGroup: true,
  emailOnAddedAsFriend: true,
  emailOnMonthlyReport: true
};

function GroupSuccessModal({ group, onClose }: { group: Group, onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const link = `${window.location.origin}/?joinCode=${group.inviteCode}`;

  const copyLink = () => {
    navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Modal onClose={onClose}>
      <div style={{ textAlign: "center", marginBottom: 20 }}>
        <div style={{ fontSize: 40, marginBottom: 10 }}>🎉</div>
        <div style={{ fontWeight: 800, fontSize: 18, color: "#0b565e" }}>Tạo nhóm thành công!</div>
        <div style={{ fontSize: 13, color: "#2d666d", marginTop: 4 }}>Nhóm "{group.name}" đã sẵn sàng.</div>
      </div>

      <Card style={{ textAlign: "center", background: "rgba(255,255,255,0.4)", border: "1.5px solid rgba(11,86,94,0.1)" }}>
        <div style={{ fontWeight: 700, fontSize: 12, color: "#0b565e", marginBottom: 16 }}>QUÉT MÃ HOẶC COPY LINK ĐỂ THAM GIA</div>
        <div style={{ background: "#fff", padding: 16, borderRadius: 16, display: "inline-block", border: "1px solid rgba(11,86,94,0.1)", marginBottom: 16 }}>
           <QRCode value={link} size={150} level="Q" />
        </div>
        <div style={{ display: "flex", gap: 8, background: "rgba(11,86,94,0.1)", padding: 8, borderRadius: 12, alignItems: "center" }}>
          <div style={{ flex: 1, fontSize: 11, color: "#0b565e", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{link}</div>
          <button onClick={copyLink} style={{ background: "#0b565e", color: "#fff", border: "none", padding: "6px 12px", borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>{copied ? "Đã copy" : "Copy"}</button>
        </div>
      </Card>

      <Btn onClick={onClose} style={{ width: "100%", padding: 14 }}>Vào nhóm ngay →</Btn>
    </Modal>
  );
}

export default function App() {
  const [tab, setTab] = useState("groups");
  const [invitations, setInvitations] = useState<GroupInvitation[]>([]);
  const [createdGroupParams, setCreatedGroupParams] = useState<{group: Group} | null>(null);
  const [joinCode, setJoinCode] = useState<string | null>(null);
  const [groupToJoin, setGroupToJoin] = useState<Group | null>(null);
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [userPrefs, setUserPrefs] = useState<UserPrefs>(DEFAULT_PREFS);
  const [groups, setGroups] = useState<Group[]>([]);
  const [friends, setFriends] = useState<Friend[]>([]);
  const [activeGroup, setActiveGroup] = useState<Group | null>(null);
  const [loading, setLoading] = useState(true);
  const [loginLoading, setLoginLoading] = useState(false);

  useEffect(() => {
    testConnection();
    const params = new URLSearchParams(window.location.search);
    const code = params.get("joinCode");
    if (code) setJoinCode(code);
  }, []);
  
  // Security & Profile state (Passcode might need to be in Firestore too, but let's keep it simple for now)
  const [passcode, setPasscode] = useState("");
  const [isLocked, setIsLocked] = useState(false);
  const [enteredPass, setEnteredPass] = useState("");
  const [profilePic, setProfilePic] = useState<string | null>(null);
  const [showEmailSettings, setShowEmailSettings] = useState(false);
  const [showAvatarModal, setShowAvatarModal] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showSecurityModal, setShowSecurityModal] = useState(false);

  const updateProfile = async (updates: Partial<UserProfile>) => {
    if (!user || !profile) return;
    const updated = { ...profile, ...updates };
    setProfile(updated);
    try {
      await updateDoc(doc(db, "users", user.uid), clean(updates));
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, "profile");
    }
  };

  const updatePrefs = async (newPrefs: Partial<UserPrefs>) => {
    if (!user) return;
    const updated = { ...userPrefs, ...newPrefs };
    setUserPrefs(updated);
    try {
      await updateDoc(doc(db, "users", user.uid), { prefs: clean(updated) });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, "prefs");
    }
  };

  useEffect(() => {
    if (!user || !user.email) return;
    const q = query(collection(db, "groupInvitations"), where("email", "==", user.email.toLowerCase()), where("status", "==", "pending"));
    const unsub = onSnapshot(q, (snap) => {
      console.log("Fetched group invitations:", snap.docs.length);
      setInvitations(snap.docs.map(d => ({ id: d.id, ...d.data() } as GroupInvitation)));
    }, (err) => {
      handleFirestoreError(err, OperationType.LIST, "groupInvitations");
    });
    return unsub;
  }, [user]);

  const acceptInvitation = async (inv: GroupInvitation) => {
    if (!user || !profile) return;
    try {
      // 1. Join group logic
      const gRef = doc(db, "groups", inv.groupId);
      const gSnap = await getDoc(gRef);
      if (gSnap.exists()) {
        const gData = gSnap.data();
        const memberUids = gData.memberUids || [];
        if (!memberUids.includes(user.uid)) {
          const newUids = [...memberUids, user.uid];
          const newMembers = [...(gData.members || []), profile.name];
          const newDetails = { ...(gData.memberDetails || {}), [user.uid]: { email: user.email, avatar: profile.avatar || "" } };
          await updateDoc(gRef, { memberUids: newUids, members: newMembers, memberDetails: newDetails, updatedAt: serverTimestamp() });
          
          await addDoc(collection(db, "groups", inv.groupId, "feed"), {
            type: "join",
            text: `${profile.name} đã tham gia nhóm qua lời mời`,
            ts: Date.now(),
            icon: "👤",
            name: profile.name
          });
        }
      }
      // 2. Mark invitation as accepted
      await updateDoc(doc(db, "groupInvitations", inv.id), { status: "accepted" });
      alert("Chấp nhận lời mời thành công! 🎉");
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `groupInvitations/${inv.id}`);
    }
  };

  const declineInvitation = async (inv: GroupInvitation) => {
    try {
      await updateDoc(doc(db, "groupInvitations", inv.id), { status: "declined" });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `groupInvitations/${inv.id}`);
    }
  };

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      setUser(u);
      if (u) {
        try {
          const userRef = doc(db, "users", u.uid);
          const userSnap = await getDoc(userRef);
          if (userSnap.exists()) {
            const data = userSnap.data();
            setProfile({ 
              uid: u.uid, 
              name: data.name || u.displayName || u.email?.split("@")[0] || "Thành viên",
              avatar: data.avatar || "🐱",
              email: data.email || u.email || "",
              createdAt: data.createdAt?.seconds ? data.createdAt.seconds * 1000 : Date.now()
            });
            setUserPrefs(data.prefs || DEFAULT_PREFS);
            setShowOnboarding(false);
          } else {
            setShowOnboarding(true);
          }
        } catch (err) {
          console.error("Error fetching user profile:", err);
        }
      } else {
        setProfile(null);
        setShowOnboarding(false);
      }
      setLoading(false);
    });
    return unsub;
  }, []);

  const executeDeleteAccount = async () => {
    const currentUser = auth.currentUser;
    if (!currentUser) return;

    try {
      setShowDeleteConfirm(false);

      // Re-authenticate user before proceeding with deletion
      try {
        await reauthenticateWithPopup(currentUser, googleProvider);
      } catch (authErr: any) {
        if (authErr.code === "auth/popup-blocked") {
          alert("⚠️ Trình duyệt của bạn đang chặn popup đăng nhập của Google.\n\nVui lòng BẤM VÀO NÚT 'Mở trong tab mới' (Open in New Tab) ở góc trên bên phải màn hình để tiếp tục xóa tài khoản.");
        } else if (authErr.code === "auth/cancelled-popup-request" || authErr.code === "auth/popup-closed-by-user") {
          return;
        } else {
          console.error("Reauth error:", authErr);
          alert("❌ Xác thực thất bại, không thể xóa tài khoản. Vui lòng thử lại: " + authErr.message);
        }
        return;
      }

      setLoading(true);

      try {
        // 1. Delete friends
        const friendsSnap = await getDocs(collection(db, "users", currentUser.uid, "friends"));
        for (const d of friendsSnap.docs) await deleteDoc(d.ref);
      } catch (err) { console.error("Error deleting friends:", err); throw new Error("Lỗi khi xóa bạn bè"); }
      
      try {
        // 2. Delete groups where user is leader
        const groupsSnap = await getDocs(query(collection(db, "groups"), where("leaderUid", "==", currentUser.uid)));
        for (const d of groupsSnap.docs) {
          const subcoll = ["expenses", "payments", "feed"];
          for (const sc of subcoll) {
            const snap = await getDocs(collection(db, "groups", d.id, sc));
            for (const sd of snap.docs) await deleteDoc(sd.ref);
          }
          await deleteDoc(d.ref);
        }
      } catch (err) { console.error("Error deleting groups:", err); throw new Error("Lỗi khi xóa nhóm/hóa đơn. Chi tiết: " + String(err)); }

      try {
        // 4. Delete user doc
        await deleteDoc(doc(db, "users", currentUser.uid));
      } catch (err) { console.error("Error deleting user doc:", err); throw new Error("Lỗi khi xóa hồ sơ cá nhân"); }
      
      try {
        // 5. Delete auth user
        const email = currentUser.email;
        await currentUser.delete();
        
        alert(`✅ Thành công: Tài khoản (${email}) đã được xóa hoàn toàn.`);
        window.location.reload();
      } catch (err) { console.error("Error deleting auth:", err); throw err; }
    } catch (err: any) {
      setLoading(false);
      console.error("Delete Error:", err);
      if (err.code === 'auth/requires-recent-login') {
        alert("🔒 Vì lý do bảo mật, bạn cần đăng nhập lại trước khi xóa tài khoản.");
        await logout();
      } else {
        alert("❌ Có lỗi xảy ra khi xóa tài khoản: " + (err.message || String(err)));
      }
    }
  };

  useEffect(() => {
    if (!user) {
      setGroups([]);
      setFriends([]);
      return;
    }

    // Handle joinCode dynamically if present
    if (joinCode) {
      const loadGroupForJoin = async () => {
        try {
          const q = query(collection(db, "groups"), where("inviteCode", "==", joinCode));
          const snap = await getDocs(q);
          if (!snap.empty) {
            setGroupToJoin({ ...snap.docs[0].data(), id: snap.docs[0].id } as Group);
          } else {
            console.warn("Invalid or expired join code");
            setJoinCode(null);
          }
        } catch (e) {
          console.error("Error loading group for joinCode", e);
        }
      };
      loadGroupForJoin();
    }

    // Sync friends
    const friendsRef = collection(db, "users", user.uid, "friends");
    const unsubFriends = onSnapshot(friendsRef, (snap) => {
      setFriends(snap.docs.map(d => ({ ...d.data(), id: d.id } as Friend)));
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
    if (loginLoading) return;
    setLoginLoading(true);
    console.log("Starting login process...");
    try {
      if (!auth) {
        throw new Error("Dịch vụ xác thực chưa sẵn sàng. Vui lòng tải lại trang.");
      }
      await signInWithPopup(auth, googleProvider);
      console.log("Login successful");
    } catch (err: any) {
      console.error("Login error:", err);
      if (err.code === "auth/popup-blocked") {
        alert("⚠️ Trình duyệt của bạn đang chặn popup đăng nhập của Google.\n\nVui lòng BẤM VÀO NÚT 'Mở trong tab mới' (Open in New Tab) ở góc trên bên phải màn hình để có thể đăng nhập.");
      } else if (err.code === "auth/cancelled-popup-request" || err.code === "auth/popup-closed-by-user") {
        console.log("Login cancelled by user");
      } else {
        alert("Lỗi đăng nhập: " + (err.message || String(err)) + "\n\nNếu bạn đang dùng tên miền mới (như Netlify), hãy chắc chắn đã thêm tên miền đó vào danh sách 'Authorized domains' trong Firebase Console (Authentication > Settings > Authorized domains).");
        console.error("Auth error details:", err);
      }
    } finally {
      setLoginLoading(false);
    }
  };

  const logout = () => signOut(auth);

  const updateGroup = async (g: any) => {
    if (!user) return;
    try {
      const { id, ...data } = g;
      await updateDoc(doc(db, "groups", id), clean(data));
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
      let isPermissionError = false;
      if (err instanceof Error) {
          try {
              const info = JSON.parse(err.message);
              if (info.error && info.error.includes("Missing or insufficient permissions")) {
                  isPermissionError = true;
              }
          } catch(e) {
              if (err.message.includes("Missing or insufficient permissions")) {
                  isPermissionError = true;
              }
          }
      }
      if (isPermissionError) {
          alert("Bạn không có quyền xóa nhóm này. Chỉ trưởng nhóm mới có quyền xóa.");
      }
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

  const sendInviteEmail = async (email: string, inviterName: string, groupName?: string, inviteCode?: string, groupId?: string) => {
    const targetEmail = email.trim().toLowerCase();
    let emailSent = false;
    let invitationCreated = false;

    // 1. Try to create in-app invitation first (it's internal to our DB)
    if (groupId) {
      try {
        await addDoc(collection(db, "groupInvitations"), {
          groupId,
          groupName: groupName || "HappyShare",
          inviterName,
          inviteCode: inviteCode || "",
          email: targetEmail,
          status: "pending",
          createdAt: new Date().toISOString()
        });
        invitationCreated = true;
      } catch (err) {
        console.error("Failed to create in-app invitation:", err);
      }
    }

    // 2. Try to send email
    try {
      const inviteLink = inviteCode 
        ? `${window.location.origin}/?joinCode=${inviteCode}`
        : `${window.location.origin}`;
        
      const response = await fetch("/api/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: targetEmail,
          inviterName,
          groupName: groupName || "HappyShare",
          inviteLink
        }),
      });
      
      const data = await response.json();
      if (response.ok) {
        emailSent = true;
      } else {
        console.warn("Email API error:", data.error);
        if (response.status === 503) {
          alert("⚠️ Chú ý: Lời mời trong app đã được gửi, nhưng Email chưa gửi được do chưa cài đặt SMTP (SMTP_USER, SMTP_PASS).");
        }
      }
    } catch (err) {
      console.error("Email fetch error:", err);
    }

    if (invitationCreated || emailSent) {
      return true;
    }
    return false;
  };

  const addFriend = async (f: Friend) => {
    if (!user || !profile) return;
    if (f.email === user.email) {
      alert("Bạn không thể tự mời chính mình!");
      return;
    }
    try {
      await addDoc(collection(db, "users", user.uid, "friends"), f);
      if (f.email) {
        console.log(`[FRIEND INVITE] Sending actual email to: ${f.email}`);
        const success = await sendInviteEmail(f.email, profile.name);
        if (success) {
          console.log("Email sent successfully");
        } else {
          alert("Lời mời đã được lưu, nhưng email không gửi được. Hãy kiểm tra cấu hình SMTP.");
        }
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, "friends");
    }
  };

  const removeFriend = async (id: string) => {
    if (!user) return;
    try {
      const friendToRemove = friends.find(f => f.id === id);
      if (!friendToRemove) return;
      const { name: friendName, email: friendEmail } = friendToRemove;

      // 1. Delete friend from user's friends list
      await deleteDoc(doc(db, "users", user.uid, "friends", id));

      // 2. Remove from all groups this user is leading or part of
      for (const g of groups) {
        let isUpdated = false;
        let newMembers = [...g.members];
        let newUids = [...(g.memberUids || [])];
        let newDetails = { ...(g.memberDetails || {}) };

        // Remove by Name
        if (newMembers.includes(friendName)) {
           // Only allow removal if the current user is the leader
           const isLeader = g.leaderUid ? g.leaderUid === user.uid : g.leader === (profile?.name);
           if (isLeader && g.leader !== friendName) {
             const idx = newMembers.indexOf(friendName);
             newMembers.splice(idx, 1);
             if (newUids[idx]) newUids.splice(idx, 1);
             delete newDetails[friendName];
             isUpdated = true;
           }
        }

        // Also clean up by Email if they are in memberDetails but maybe named differently?
        // Actually, name is the primary key in members array.
        
        if (isUpdated) {
          await updateDoc(doc(db, "groups", g.id), {
            members: newMembers,
            memberUids: newUids,
            memberDetails: newDetails
          });
        }
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, "friends");
    }
  };

  const saveProfile = async (p: { name: string; avatar: string }) => {
    if (!user) return;
    try {
      const profileData = {
        uid: user.uid,
        name: p.name,
        avatar: p.avatar,
        email: user.email || "",
        createdAt: Date.now(),
        prefs: userPrefs
      };
      await setDoc(doc(db, "users", user.uid), profileData);
      setProfile(profileData as UserProfile);
      setShowOnboarding(false);
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, "users");
    }
  };

  const createGroup = async (g: any) => {
    if (!user || !profile) return;
    try {
      const groupData = {
        ...g,
        members: [profile.name],
        memberUids: [user.uid],
        memberDetails: { [profile.name]: { avatar: profile.avatar } },
        leader: profile.name,
        leaderUid: user.uid,
        createdBy: user.uid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      };
      delete groupData.id;

      const docRef = await addDoc(collection(db, "groups"), groupData);
      
      // Add initial feed
      await addDoc(collection(db, "groups", docRef.id, "feed"), {
        type: "group",
        text: `Nhóm "${g.name}" được tạo`,
        ts: Date.now(),
        icon: "🎉"
      });

      const newGroup = { ...groupData, id: docRef.id, leaderUid: user.uid };
      setActiveGroup(newGroup);
      setTab("active");
      setCreatedGroupParams({ group: newGroup as Group });
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, "groups");
    }
  };

  // Helper to map friend names to UIDs if we have them (this is complex without a global user search)
  // For now, we'll just store names and only the current user's UID for security checks.
  const selMemberUids = (names: string[]) => {
    return [user?.uid].filter(Boolean) as string[];
  };

  // Sync avatars for friends and groups
  useEffect(() => {
    if (!user || !friends.length) return;
    
    const syncAvatars = async () => {
        const friendsToSync = friends.filter(f => f.email && !f.avatar);
        if (friendsToSync.length === 0) return;

        for (const f of friendsToSync) {
            try {
                const q = query(collection(db, "users"), where("email", "==", f.email));
                const snap = await getDocs(q);
                if (!snap.empty) {
                    const userData = snap.docs[0].data();
                    if (userData.avatar) {
                        await updateDoc(doc(db, "users", user.uid, "friends", f.id!), {
                            avatar: userData.avatar,
                            avatarSyncedAt: Date.now()
                        });
                    }
                }
            } catch (e) {
                console.error("Sync avatar error", e);
            }
        }
    };

    const timer = setTimeout(syncAvatars, 2000);
    return () => clearTimeout(timer);
  }, [user?.uid, friends.length]);

  const selectGroup = (g: Group) => { setActiveGroup(g); setTab("active"); };

  const addExpenseToGroup = async (groupId: string, exp: any) => {
    try {
      const g = groups.find(x => x.id === groupId);
      const { id, ...data } = exp;
      await addDoc(collection(db, "groups", groupId, "expenses"), clean({ 
        ...data, 
        createdBy: auth.currentUser?.uid,
        memberDetails: g?.memberDetails || {}
      }));
      const mainPayer = Object.keys(exp.payers).find(k => (exp.payers[k] || 0) > 0) || "Ai đó";
      const currency = profile?.currency || "đ";
      await addDoc(collection(db, "groups", groupId, "feed"), {
        type: "expense",
        text: `${mainPayer} đã quét hoá đơn "${exp.desc}" — ${fmt(exp.amount, currency)}`,
        ts: Date.now(),
        icon: "📷",
        name: mainPayer
      });
      setTab("active");
      setActiveGroup(groups.find(g => g.id === groupId) || null);
    } catch(err) {
      handleFirestoreError(err, OperationType.CREATE, `groups/${groupId}/expenses`);
    }
  };

  const tabs = [
    { id: "groups", icon: "🏠", label: "Nhóm" },
    { id: "friends", icon: "👥", label: "Bạn bè" },
    { id: "qr", icon: <Receipt size={20} strokeWidth={2.5} />, label: "Quét bill" },
    { id: "settings", icon: "⚙️", label: "Cài đặt" },
  ];

  const handlePicUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && profile) {
      if (file.size > 500 * 1024) {
        alert("🚨 File size too large (max 500KB)");
        return;
      }
      const reader = new FileReader();
      reader.onloadend = async () => {
        const base64Avatar = reader.result as string;
        try {
          await updateDoc(doc(db, "users", profile.uid), { avatar: base64Avatar });
          setProfile({ ...profile, avatar: base64Avatar });
          setProfilePic(base64Avatar);
          setShowAvatarModal(false);
        } catch (err) {
          handleFirestoreError(err, OperationType.UPDATE, "users");
        }
      };
      reader.readAsDataURL(file);
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
      <div style={{minHeight:"100vh", display:"flex", alignItems:"center", justifyContent:"center", background:"linear-gradient(135deg, #82edc0, #7be0dc, #7fe7cd, #88e7c8)", color:"#0b565e"}}>
         <div style={{fontSize: 24, fontWeight: 700}}>Đang tải...</div>
      </div>
    );
  }

  if (!user) {
    return (
      <div style={{minHeight:"100vh", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", background:"linear-gradient(135deg, #82edc0, #7be0dc, #7fe7cd, #88e7c8)", color:"#0b565e", padding:20, textAlign: "center"}}>
        <div style={{fontSize:80, marginBottom:20}}>✨</div>
        <h1 style={{fontSize: 32, fontWeight: 900, marginBottom: 10, color: "#0b565e"}}>Chào mừng đến với HappyShare</h1>
        <p style={{fontSize: 14, color: "#0b565e", opacity: 0.8, marginBottom: 30, maxWidth: 300}}>
          Ứng dụng chia sẻ hóa đơn thông minh và minh bạch. Đăng nhập để bắt đầu!
        </p>
        <Btn onClick={login} disabled={loginLoading} style={{width: 260, fontSize: 16, padding: "14px 20px", marginBottom: 15, display: "flex", alignItems: "center", justifyContent: "center", gap: 10}}>
          {loginLoading ? <Loader2 className="animate-spin" size={20} /> : "🚀"} 
          {loginLoading ? "Đang xử lý..." : "Đăng nhập bằng Google"}
        </Btn>
        <p style={{fontSize: 12, color: "#0b565e", opacity: 0.6, maxWidth: 280}}>
          Nếu không thấy cửa sổ đăng nhập hiện ra, hãy nhấn nút <b>"Mở trong tab mới"</b> ở góc trên bên phải màn hình.
        </p>
      </div>
    );
  }

  if (isLocked && passcode) {
    return (
      <div style={{minHeight:"100vh", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", background:"linear-gradient(135deg, #82edc0, #7be0dc, #7fe7cd, #88e7c8)", color:"#0b565e", padding:20}}>
        <div style={{fontSize:48, marginBottom:20}}>🔒</div>
        <h2 style={{marginBottom:20}}>HappyShare Locked</h2>
        <Input 
          type="password" 
          placeholder="Nhập mã bảo mật..." 
          value={enteredPass} 
          onChange={(e: any) => setEnteredPass(e.target.value)}
          onKeyDown={(e: any) => e.key === "Enter" && unlock()}
          style={{maxWidth:300, textAlign:"center", fontSize:18, letterSpacing:4, color: "#0b565e"}}
        />
        <Btn onClick={unlock} style={{marginTop:20, width:300}}>Mở khóa</Btn>
      </div>
    );
  }

  return (
    <div style={{minHeight:"100vh",display:"flex",flexDirection:"column",background:"linear-gradient(135deg, #82edc0, #7be0dc, #7fe7cd, #88e7c8)", color: "#0b565e"}}>
      {createdGroupParams && (
        <GroupSuccessModal 
          group={createdGroupParams.group} 
          onClose={() => setCreatedGroupParams(null)} 
        />
      )}
      {groupToJoin && profile && (
        <JoinGroupModal
          group={groupToJoin}
          profile={profile}
          onClose={() => { setGroupToJoin(null); setJoinCode(null); }}
          onJoined={(g) => {
            setGroupToJoin(null);
            setJoinCode(null);
            setActiveGroup(g);
            setTab("active");
            window.history.replaceState({}, document.title, window.location.pathname);
          }}
        />
      )}
      {showOnboarding && (
        <Modal onClose={() => {}}>
          <div style={{ textAlign: "center", padding: "20px 0" }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>👋</div>
            <div style={{ fontWeight: 900, fontSize: 20, marginBottom: 8, color: "#0b565e" }}>Chào mừng bạn!</div>
            <div style={{ fontSize: 14, color: "#2d666d", marginBottom: 24 }}>Vui lòng hoàn tất hồ sơ để bắt đầu sử dụng.</div>
            
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#1a4d53", textAlign: "left", marginBottom: 6 }}>Tên hiển thị</div>
              <input 
                placeholder="Nhập tên của bạn..." 
                defaultValue={user?.displayName || ""} 
                id="onboarding-name"
                style={{ width: "100%", padding: "12px", borderRadius: 10, border: "1px solid #e2e8f0", background: "#fff", outline: "none" }}
              />
            </div>

            <div style={{ marginBottom: 24 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#1a4d53", textAlign: "left", marginBottom: 12 }}>Chọn Avatar</div>
              
              <div style={{ marginBottom: 15, textAlign: "center" }}>
                <input 
                  type="file" 
                  id="onboarding-upload" 
                  hidden 
                  accept="image/*" 
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      if (file.size > 500 * 1024) { alert("🚨 File quá lớn (tối đa 500KB)"); return; }
                      const reader = new FileReader();
                      reader.onloadend = () => {
                        const base64 = reader.result as string;
                        (window as any)._selectedAvatar = base64;
                        // Clear emoji selection UI
                        document.querySelectorAll('.av-choice').forEach(b => (b as HTMLElement).style.border = "2px solid #f1f5f9");
                        // Preview
                        const preview = document.getElementById("avatar-preview");
                        if (preview) preview.innerHTML = `<img src="${base64}" style="width: 60px; height: 60px; border-radius: 50%; object-fit: cover; border: 3px solid #059669" />`;
                      };
                      reader.readAsDataURL(file);
                    }
                  }} 
                />
                <div id="avatar-preview" style={{ marginBottom: 10, display: "flex", justifyContent: "center" }}>
                  <div style={{ width: 60, height: 60, borderRadius: "50%", background: "#f1f5f9", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 32, border: "3px solid transparent" }}>
                    ?
                  </div>
                </div>
                <label htmlFor="onboarding-upload" style={{ display: "inline-block", background: "#ecfdf5", color: "#059669", padding: "8px 16px", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: "pointer", border: "1.5px solid #059669" }}>
                  📷 Tải ảnh lên
                </label>
              </div>

              <div style={{ display: "flex", flexWrap: "wrap", gap: 10, justifyContent: "center" }}>
                {["🐱", "🐶", "🦊", "🐻", "🐼", "🦁", "🐧", "🦄", "🐸", "🐰", "🐯", "🐨", "🐷", "🐵", "🐙", "🐢", "🐔", "🐦"].map(av => (
                  <button 
                    key={av}
                    onClick={() => {
                      const btns = document.querySelectorAll('.av-choice');
                      btns.forEach(b => (b as HTMLElement).style.border = "2px solid #f1f5f9");
                      const btn = document.getElementById(`av-${av}`);
                      if (btn) btn.style.border = "2px solid #059669";
                      (window as any)._selectedAvatar = av;
                      // Clear preview
                      const preview = document.getElementById("avatar-preview");
                      if (preview) preview.innerHTML = `<div style="width: 60px; height: 60px; border-radius: 50%; background: #fff; display: flex; align-items: center; justify-content: center; fontSize: 32; border: 3px solid #059669">${av}</div>`;
                    }}
                    id={`av-${av}`}
                    className="av-choice"
                    style={{ width: 44, height: 44, borderRadius: 12, background: "#fff", border: "2px solid #f1f5f9", fontSize: 20, cursor: "pointer", transition: "all 0.2s" }}
                  >
                    {av}
                  </button>
                ))}
              </div>
            </div>

            <Btn 
              onClick={() => {
                const nameInput = document.getElementById("onboarding-name") as HTMLInputElement;
                const name = nameInput.value.trim();
                const avatar = (window as any)._selectedAvatar || "🐱";
                if (!name) { alert("Vui lòng nhập tên!"); return; }
                saveProfile({ name, avatar });
              }} 
              style={{ width: "100%", padding: "14px" }}
            >
              🚀 Bắt đầu ngay
            </Btn>
          </div>
        </Modal>
      )}

      {/* HEADER */}
      <div style={{padding:"20px 20px 15px", background: "rgba(255,255,255,0.2)", borderBottom: "1px solid rgba(11,86,94,0.1)", display: "flex", alignItems: "center", justifyContent: "space-between"}}>
        <div 
          onClick={() => setTab("settings")}
          style={{cursor: "pointer", transition: "transform 0.2s"}}
        >
          <Av name={profile?.name || "ME"} size={40} avatar={profilePic || profile?.avatar || ""} style={{ border: "2px solid #0b565e" }} />
        </div>
        <div style={{textAlign: "center"}}>
          <h1 style={{color:"#0b565e", fontSize:22, fontWeight:900, letterSpacing:-0.5, margin:0}}>✨ HappyShare</h1>
          <p style={{color:"#1a4d53", fontSize:11, margin:"2px 0 0", fontWeight: 700}}>Dividing Joy, Not Just Bills</p>
        </div>
        <div style={{width: 40}} /> {/* Spacer for balance */}
      </div>

      {/* INVITATIONS */}
      {invitations.length > 0 && (
        <div style={{ padding: "0 20px 10px" }}>
          {invitations.map(inv => (
            <div key={inv.id} style={{ 
              background: "linear-gradient(135deg, #10b981, #059669)", 
              color: "#fff", 
              padding: "12px 16px", 
              borderRadius: 14, 
              marginBottom: 8, 
              boxShadow: "0 4px 12px rgba(16, 185, 129, 0.2)",
              display: "flex",
              alignItems: "center",
              gap: 12
            }}>
              <div style={{ fontSize: 24 }}>✉️</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 800, fontSize: 13 }}>Lời mời vào nhóm!</div>
                <div style={{ fontSize: 11, opacity: 0.9 }}>
                  <b>{inv.inviterName}</b> mời bạn vào <b>{inv.groupName}</b>
                </div>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button 
                  onClick={() => acceptInvitation(inv)}
                  style={{ background: "#fff", color: "#059669", border: "none", borderRadius: 8, padding: "6px 12px", fontSize: 11, fontWeight: 800, cursor: "pointer" }}
                >
                  Chấp nhận
                </button>
                <button 
                   onClick={() => declineInvitation(inv)}
                  style={{ background: "rgba(255,255,255,0.2)", color: "#fff", border: "none", borderRadius: 8, padding: "6px 10px", fontSize: 11, fontWeight: 800, cursor: "pointer" }}
                >
                  Bỏ qua
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{flex:1,overflowY:"auto",paddingBottom:70}}>
        {tab==="groups"&& (
          <GroupsListView groups={groups} friends={friends} onSelectGroup={selectGroup} onCreateGroup={createGroup} currency={profile?.currency || "đ"}/>
        )}
        {tab==="active"&&activeGroup&&(
          <GroupView group={groups.find(g=>g.id===activeGroup.id)||activeGroup} friends={friends} profile={profile} onUpdate={updateGroup} onDelete={()=>deleteGroup(activeGroup)} onLeave={()=>leaveGroup(activeGroup)} onBack={() => setTab("groups")} sendInviteEmail={sendInviteEmail}/>
        )}
        {tab==="friends"&&<FriendsView friends={friends} groups={groups} onAddFriend={addFriend} onRemoveFriend={removeFriend} onPayClick={(g) => selectGroup(g)} currency={profile?.currency || "đ"}/>}
        {tab==="qr" && <ReceiptScannerView groups={groups} onAddExpense={addExpenseToGroup} currency={profile?.currency || "đ"} />}
        {tab==="settings" && (
          <div style={{padding:14}}>
            {/* Account Settings */}
            <Card>
              <SecTitle icon="👤" title="Tài khoản" color="#059669"/>
              <div style={{display:"flex", alignItems:"center", gap:12}}>
                <Av name={profile?.name || "ME"} size={54} avatar={profilePic || profile?.avatar || ""} style={{ border: "2px solid #059669" }} />
                <div style={{flex:1, overflow:"hidden"}}>
                  <div style={{fontWeight:800, fontSize:16, color: "#0b565e", marginBottom: 2, whiteSpace:"nowrap", textOverflow:"ellipsis", overflow:"hidden"}}>{profile?.name || "Người dùng"}</div>
                  <div style={{fontWeight:500, fontSize:12, color: "#2d666d", whiteSpace:"nowrap", textOverflow:"ellipsis", overflow:"hidden"}}>{profile?.email || ""}</div>
                </div>
                <button onClick={() => setShowAvatarModal(true)} style={{background:"#f1f5f9", color:"#334155", padding:"8px 12px", borderRadius:8, fontSize:12, fontWeight:700, border:"none", cursor:"pointer", flexShrink:0}}>📷 Đổi ảnh</button>
              </div>
            </Card>

            {/* Sở thích */}
            <Card>
               <SecTitle icon="⚙️" title="Sở thích" color="#059669"/>
               
               <div style={{marginBottom:10}}>
                 <div 
                   onClick={() => setShowSecurityModal(true)} 
                   style={{display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", padding: "10px 0"}}
                 >
                   <div style={{display: "flex", alignItems: "center", gap: 8}}>
                      <span style={{fontSize: 16}}>🔒</span>
                      <div style={{fontSize:13, fontWeight:700, color:"#0b565e"}}>Bảo mật & Tài khoản</div>
                   </div>
                   <span style={{fontSize: 18, color: "#94a3b8"}}>›</span>
                 </div>
               </div>

               <div>
                 <div style={{display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0"}}>
                   <div style={{display: "flex", alignItems: "center", gap: 8}}>
                      <span style={{fontSize: 16}}>💰</span>
                      <div style={{fontSize:13, fontWeight:700, color:"#0b565e"}}>Đơn vị tiền tệ</div>
                   </div>
                   <select 
                     value={profile?.currency || "đ"} 
                     onChange={(e) => updateProfile({ currency: e.target.value })}
                     style={{
                       background: "#f1f5f9",
                       border: "none",
                       borderRadius: 8,
                       padding: "6px 10px",
                       fontSize: 12,
                       fontWeight: 700,
                       color: "#0b565e",
                       cursor: "pointer"
                     }}
                   >
                     <option value="đ">VNĐ (đ)</option>
                     <option value="$">USD ($)</option>
                     <option value="€">EUR (€)</option>
                     <option value="¥">JPY (¥)</option>
                     <option value="£">GBP (£)</option>
                     <option value="₩">KRW (₩)</option>
                     <option value="元">CNY (元)</option>
                     <option value="S$">SGD (S$)</option>
                     <option value="฿">THB (฿)</option>
                     <option value="A$">AUD (A$)</option>
                     <option value="C$">CAD (C$)</option>
                     <option value="CHF">CHF (Fr)</option>
                     <option value="HK$">HKD (HK$)</option>
                     <option value="NT$">TWD (NT$)</option>
                     <option value="RM">MYR (RM)</option>
                     <option value="Rp">IDR (Rp)</option>
                     <option value="₱">PHP (₱)</option>
                     <option value="₹">INR (₹)</option>
                     <option value="₽">RUB (₽)</option>
                     <option value="R$">BRL (R$)</option>
                     <option value="ZAR">ZAR (R)</option>
                   </select>
                 </div>
               </div>
            </Card>

            {/* Premium */}
            <Card style={{ background: "linear-gradient(135deg, #fffbeb 0%, #fff 100%)", borderColor: "#fef3c7" }}>
               <SecTitle icon="👑" title="Premium" color="#d97706"/>
               <div style={{ display: "flex", flexDirection: "column", gap: 14, marginBottom: 18 }}>
                 <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                   <div style={{ background: "#fee2e2", width: 34, height: 34, borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16 }}>🚫</div>
                   <div style={{ fontSize: 13, fontWeight: 700, color: "#334155" }}>Không có quảng cáo</div>
                 </div>
                 <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                   <div style={{ background: "#e0f2fe", width: 34, height: 34, borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16 }}>☁️</div>
                   <div style={{ fontSize: 13, fontWeight: 700, color: "#334155" }}>Sao lưu iCloud</div>
                 </div>
                 <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                   <div style={{ background: "#dcfce7", width: 34, height: 34, borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16 }}>📊</div>
                   <div style={{ fontSize: 13, fontWeight: 700, color: "#334155" }}>Xuất và in dữ liệu Excel</div>
                 </div>
                 <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                   <div style={{ background: "#f3e8ff", width: 34, height: 34, borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16 }}>💳</div>
                   <div style={{ fontSize: 13, fontWeight: 700, color: "#334155" }}>Thanh toán trong app</div>
                 </div>
                 <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                   <div style={{ background: "#ffedd5", width: 34, height: 34, borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16 }}>🚀</div>
                   <div style={{ fontSize: 13, fontWeight: 700, color: "#334155" }}>Tính năng sắp ra mắt</div>
                 </div>
               </div>
               <Btn style={{ width: "100%", background: "linear-gradient(135deg, #f59e0b, #d97706)", color: "#fff", display: "flex", justifyContent: "center", alignItems: "center", padding: "14px", border: "none", borderRadius: 12, fontWeight: 800, fontSize: 14, boxShadow: "0 4px 14px rgba(245, 158, 11, 0.3)", letterSpacing: 0.5 }} onClick={() => {}}>
                 Thanh toán ({fmt(499000, profile?.currency || "đ")})
               </Btn>
            </Card>

            {showSecurityModal && (
              <Modal onClose={() => setShowSecurityModal(false)}>
                <SecTitle icon="🔒" title="Bảo mật" color="#059669" />
                <div style={{marginBottom: 20}}>
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
                    <Btn onClick={() => {setIsLocked(true); setShowSecurityModal(false);}} color="#ef4444" style={{width:"100%", marginTop: 10, fontSize: 12}}>Khóa ngay bây giờ</Btn>
                  )}
                </div>
              </Modal>
            )}

            {showEmailSettings && <EmailSettingsModal prefs={userPrefs} onUpdate={updatePrefs} onClose={() => setShowEmailSettings(false)} />}

            {/* Hệ thống */}
            <Card>
               <SecTitle icon="🚪" title="Hệ thống" color="#374151"/>
               <div style={{display:"flex", gap:8}}>
                 <Btn onClick={logout} color="#374151" style={{flex:1, fontSize:13, padding:"10px", display: "flex", alignItems: "center", justifyContent: "center", gap: 6}}>
                   <LogOut size={16} />
                   Đăng xuất
                 </Btn>
                 <button 
                   onClick={() => setShowDeleteConfirm(true)}
                   style={{
                     flex: 1,
                     background: "#dc2626",
                     color: "#ffffff",
                     border: "none",
                     borderRadius: 12,
                     padding: "10px",
                     fontSize: 11,
                     fontWeight: 800,
                     cursor: "pointer",
                     display: "flex",
                     alignItems: "center",
                     justifyContent: "center",
                     gap: 4
                   }}
                 >
                   🗑️ Xóa Vĩnh Viễn TK
                 </button>
               </div>
            </Card>

            {showAvatarModal && (
              <Modal onClose={() => setShowAvatarModal(false)}>
                <SecTitle icon="🖼️" title="Đổi ảnh đại diện" color="#059669" />
                <div style={{ marginBottom: 20 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#1a4d53", marginBottom: 12 }}>Chọn ảnh có sẵn:</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 10, justifyContent: "center", marginBottom: 20 }}>
                    {["🐱", "🐶", "🦊", "🐻", "🐼", "🦁", "🐧", "🦄", "🐸", "🐰", "🐯", "🐨", "🐷", "🐵", "🐙", "🐢", "🐔", "🐦"].map(av => (
                      <button 
                        key={av}
                        onClick={async () => {
                          if (!profile) return;
                          setLoading(true);
                          try {
                            await updateDoc(doc(db, "users", profile.uid), { avatar: av });
                            const newProfile = { ...profile, avatar: av };
                            setProfile(newProfile);
                            setProfilePic(av);
                            setShowAvatarModal(false);
                          } catch(err) {
                            console.error(err);
                          } finally {
                            setLoading(false);
                          }
                        }}
                        style={{ width: 44, height: 44, borderRadius: 12, border: "2px solid #f1f5f9", background: "#fff", fontSize: 24, cursor: "pointer", transition: "0.2s" }}
                      >
                        {av}
                      </button>
                    ))}
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#1a4d53", marginBottom: 12, textAlign: "center" }}>Hoặc tải ảnh từ thiết bị:</div>
                  <div style={{ textAlign: "center", marginBottom: 10 }}>
                    <input type="file" id="pfp-upload" hidden accept="image/*" onChange={(e) => { handlePicUpload(e); setShowAvatarModal(false); }} />
                    <label htmlFor="pfp-upload" style={{display:"inline-block", background:"#ecfdf5", color:"#059669", padding:"12px 20px", borderRadius:12, fontSize:14, fontWeight:700, cursor:"pointer", border: "2px solid #6ee7b7"}}>📸 Chọn ảnh từ máy</label>
                  </div>
                </div>
              </Modal>
            )}

            {showDeleteConfirm && (
              <Modal onClose={() => setShowDeleteConfirm(false)}>
                <div style={{ textAlign: "center" }}>
                  <div style={{ fontSize: 40, marginBottom: 12 }}>⚠️</div>
                  <h3 style={{ margin: "0 0 12px 0", color: "#991b1b", fontSize: 18 }}>Cảnh Báo Tối Cao</h3>
                  <p style={{ margin: "0 0 16px 0", fontSize: 13, color: "#ef4444", fontWeight: 600, lineHeight: 1.5 }}>
                    Bạn sắp <b>XÓA VĨNH VIỄN</b> tài khoản HappyShare này!<br/><br/>
                    Toàn bộ hồ sơ, nhóm (do bạn tạo), bạn bè và lịch sử hóa đơn sẽ bị xóa sạch khỏi hệ thống.<br/><br/>
                    Hành động này KHÔNG THỂ KHÔI PHỤC!
                  </p>
                  <div style={{ display: "flex", gap: 10 }}>
                    <Btn onClick={() => setShowDeleteConfirm(false)} color="#94a3b8" style={{ flex: 1 }}>Hủy bỏ</Btn>
                    <Btn onClick={executeDeleteAccount} color="#dc2626" style={{ flex: 1 }}>Xác nhận Xóa</Btn>
                  </div>
                </div>
              </Modal>
            )}
          </div>
        )}
      </div>

      <div style={{position:"fixed",bottom:12,left:12,right:12,background:"rgba(255,255,255,0.9)", backdropFilter:"blur(10px)",borderRadius:20,display:"flex",padding:"8px 4px",boxShadow:"0 8px 32px rgba(11,86,94,0.15)",zIndex:1000, border:"1px solid rgba(255,255,255,0.5)"}}>
        {tabs.map(t=>(
          <button key={t.id} onClick={()=>setTab(t.id)} style={{flex:1,padding:"4px 0",border:"none",background:"none",cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",gap:2, position:"relative"}}>
            <div style={{fontSize:18, height: 24, display: "flex", alignItems: "center", justifyContent: "center", color:(tab===t.id || (t.id==="groups" && tab==="active"))?"#0b565e":"#2d666d", transform: (tab===t.id || (t.id==="groups" && tab==="active")) ? "translateY(-1px)" : "none", transition: "0.2s"}}>{t.icon}</div>
            <span style={{fontSize:9,color:(tab===t.id || (t.id==="groups" && tab==="active"))?"#0b565e":"#2d666d", fontWeight:700, letterSpacing:0.3, opacity: (tab===t.id || (t.id==="groups" && tab==="active")) ? 1 : 0.6}}>{t.label}</span>
            {(tab===t.id || (t.id==="groups" && tab==="active")) && <div style={{position:"absolute", bottom:-2, width:4, height:4, borderRadius:"50%", background:"#0b565e"}} />}
          </button>
        ))}
      </div>
    </div>
  );
}
