import React, { useState, useMemo, useEffect, useRef } from "react";
import { QrCode, Receipt, Upload, Loader2, ImagePlus, Camera } from "lucide-react";
import { initializeApp } from "firebase/app";
import { getAuth, onAuthStateChanged, signInWithPopup, GoogleAuthProvider, signOut, User as FirebaseUser } from "firebase/auth";
import { getFirestore, collection, doc, setDoc, getDoc, getDocs, onSnapshot, query, where, addDoc, updateDoc, deleteDoc, serverTimestamp, getDocFromServer, orderBy } from "firebase/firestore";
import { GoogleGenAI, Type } from "@google/genai";
import firebaseConfig from "../firebase-applet-config.json";

// Initialize AI
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

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
testConnection();

// ─── Constants ───────────────────────────────────────────────
const COLORS = ["#7C3AED","#2563EB","#DB2777","#D97706","#059669","#DC2626","#0891B2","#9333EA","#EA580C","#0D9488"];
const EMOJIS = ["🏖️","🍜","🎉","✈️","🏠","🎮","🛒","🍻","🏕️","💼"];
const fmt = (n: number) => new Intl.NumberFormat("vi-VN",{style:"currency",currency:"VND"}).format(Math.round(n));
const fmtShort = (n: number) => { if(Math.abs(n)>=1e6) return (n/1e6).toFixed(1)+"tr"; if(Math.abs(n)>=1e3) return (n/1e3).toFixed(0)+"k"; return String(Math.round(n)); };
const timeAgo = (ts: number) => { const s=Math.floor((Date.now()-ts)/1000); if(s<60)return"vừa xong"; if(s<3600)return`${Math.floor(s/60)}p trước`; if(s<86400)return`${Math.floor(s/3600)}h trước`; return`${Math.floor(s/86400)}d trước`; };
const genCode = () => Math.random().toString(36).slice(2,8).toUpperCase();

const sendEmailInvite = async (email: string, inviterName: string, groupName: string, inviteId: string) => {
  try {
    const inviteLink = `${window.location.origin}/?inviteId=${inviteId}`;
    const res = await fetch("/api/invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, inviterName, groupName, inviteLink }),
    });
    const data = await res.json();
    if (!res.ok) {
      if (res.status === 503) {
        alert("⚠️ Email chưa được gửi: Bạn cần cấu hình SMTP_USER và SMTP_PASS trong phần Settings của AI Studio.");
      } else {
        alert("❌ Lỗi gửi email: " + (data.error || "Không xác định"));
      }
      return false;
    }
    alert("✅ Đã gửi email mời đến: " + email);
    return true;
  } catch (err) {
    console.error("Failed to send email invite:", err);
    alert("❌ Không thể kết nối với máy chủ gửi email.");
    return false;
  }
};

// ─── Types ───────────────────────────────────────────────────
interface Friend {
  id?: string;
  name: string;
  email: string;
  status: 'pending' | 'accepted';
  createdAt: number;
}

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
  ts: number;
  items?: ReceiptItem[]; // For itemized mode
  memberDetails?: Record<string, { phone?: string; email?: string; avatar?: string }>;
}

interface Invitation {
  id: string;
  groupId: string;
  inviterName: string;
  email: string;
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
    if (exp.splitMode === "itemized") {
      let share = 0;
      exp.items?.forEach(item => {
        if (item.assignedTo && item.assignedTo.length > 0) {
          if (item.assignedTo.includes(m)) {
            share += item.price / item.assignedTo.length;
          }
        } else {
          // If no one is assigned, split this item evenly among all members
          share += item.price / members.length;
        }
      });
      // Handle remaining amount if any (e.g. tax/tip)
      const allocated = exp.items?.reduce((sum, it) => sum + (it.price || 0), 0) || 0;
      const remaining = exp.amount - allocated;
      if (remaining > 0.01) {
        share += remaining / members.length; // distribute tax equally among all members
      }
      return share;
    }
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
  memberDetails?: Record<string, { phone?: string; email?: string; avatar?: string }>;
  leader: string;
  leaderUid: string;
  expenses?: Expense[];
  payments?: Payment[];
  feed?: FeedItem[];
  inviteCode: string;
  dueDate: string;
}

// ─── Tiny Components ─────────────────────────────────────────
function Av({ name, size=36, ci=0, avatar, style={} }: { name: string, size?: number, ci?: number, avatar?: string, style?: any }) {
  if (avatar) {
    return <img src={avatar} style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover", flexShrink: 0, ...style }} alt={name} />;
  }
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

function JoinGroupView({ inviteId, onJoined, profile }: { inviteId: string, onJoined: (group: Group) => void, profile: UserProfile | null }) {
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [group, setGroup] = useState<Group | null>(null);
  const [name, setName] = useState(profile?.name || auth.currentUser?.displayName || "");
  const [avatar, setAvatar] = useState<string | null>(profile?.avatar || null);
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);

  useEffect(() => {
    if (profile) {
      setName(profile.name);
      setAvatar(profile.avatar);
    }
  }, [profile]);

  useEffect(() => {
    const load = async () => {
      try {
        const invDoc = await getDoc(doc(db, "invitations", inviteId));
        if (invDoc.exists()) {
          const invData = invDoc.data() as Invitation;
          setInvitation(invData);
          const grpDoc = await getDoc(doc(db, "groups", invData.groupId));
          if (grpDoc.exists()) {
            setGroup({ ...grpDoc.data(), id: grpDoc.id } as Group);
          }
        }
      } catch (err) {
        handleFirestoreError(err, OperationType.GET, `invitations/${inviteId}`);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [inviteId]);

  const handleJoin = async () => {
    if (!name.trim() || !group || joining) return;
    setJoining(true);
    try {
      const newMembers = [...group.members, name.trim()];
      const currentUids = group.memberUids || [];
      const newUids = [...currentUids, auth.currentUser?.uid || ""];
      const newDetails = { ...(group.memberDetails || {}) };
      if (avatar || profile?.avatar) {
        newDetails[name.trim()] = { ...(newDetails[name.trim()] || {}), avatar: avatar || profile?.avatar };
      }
      
      await updateDoc(doc(db, "groups", group.id), {
        members: newMembers,
        memberUids: newUids,
        memberDetails: newDetails
      });

      // Optionally delete invitation
      await deleteDoc(doc(db, "invitations", inviteId));

      onJoined({ ...group, members: newMembers, memberUids: newUids, memberDetails: newDetails });
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, "joining group");
    } finally {
      setJoining(false);
    }
  };

  useEffect(() => {
    // If profile is already set, auto join if possible or just show confirmation
    // For now let's just prefill and let them click "Join"
  }, [profile]);

  const handleAvatarFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (ev) => setAvatar(ev.target?.result as string);
      reader.readAsDataURL(file);
    }
  };

  if (loading) return <div style={{height: "100vh", display: "flex", alignItems: "center", justifyContent: "center"}}><Loader2 className="animate-spin" color="#7c3aed" /></div>;
  if (!invitation || !group) return <div style={{padding: 40, textAlign: "center"}}>Lời mời không hợp lệ hoặc đã hết hạn.</div>;

  return (
    <div style={{minHeight: "100vh", background: "linear-gradient(135deg, #f5f3ff 0%, #ede9fe 100%)", padding: "40px 20px", display: "flex", flexDirection: "column", alignItems: "center"}}>
      <div style={{fontSize: 60, marginBottom: 20}}>{group.emoji}</div>
      <div style={{textAlign: "center", marginBottom: 30}}>
        <div style={{fontSize: 20, fontWeight: 800, color: "#1e1e2e"}}>Chào mừng bạn đến với {group.name}</div>
        <div style={{fontSize: 14, color: "#64748b", marginTop: 6}}><b>{invitation.inviterName}</b> đã mời bạn tham gia nhóm này.</div>
      </div>

      <Card style={{width: "100%", maxWidth: 400, padding: 24}}>
        <div style={{textAlign: "center", marginBottom: 20}}>
          <div style={{position: "relative", display: "inline-block"}}>
            {avatar ? (
              <img src={avatar} style={{width: 90, height: 90, borderRadius: "50%", objectFit: "cover", border: "4px solid #fff", boxShadow: "0 4px 12px rgba(0,0,0,0.1)"}} />
            ) : (
              <Av name={name || "User"} size={90} ci={0} style={{border: "4px solid #fff", boxShadow: "0 4px 12px rgba(0,0,0,0.1)"}} />
            )}
            <label style={{position: "absolute", bottom: 0, right: 0, background: "#7c3aed", color: "#fff", width: 28, height: 28, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", border: "2px solid #fff"}}>
              <Camera size={14} />
              <input type="file" accept="image/*" onChange={handleAvatarFile} style={{display: "none"}} />
            </label>
          </div>
          <div style={{fontSize: 12, color: "#94a3b8", marginTop: 8}}>Tải ảnh đại diện (tuỳ chọn)</div>
        </div>

        <div style={{marginBottom: 20}}>
          <div style={{fontSize: 12, fontWeight: 700, color: "#1e1e2e", marginBottom: 6}}>BẠN TÊN LÀ GÌ?</div>
          <Input placeholder="Nhập tên của bạn..." value={name} onChange={(e:any) => setName(e.target.value)} />
        </div>

        <Btn onClick={handleJoin} disabled={!name.trim() || joining} style={{width: "100%", padding: 15, fontSize: 15}}>
          {joining ? <Loader2 className="animate-spin" /> : "Tham gia nhóm ngay 🚀"}
        </Btn>
      </Card>
      <div style={{marginTop: 20, fontSize: 12, color: "#94a3b8"}}>HappyShare — Quản lý chi tiêu nhóm dễ dàng</div>
    </div>
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

function BillDetailModal({ bill, members, onClose, onRemove }: { bill: Expense, members: string[], onClose: () => void, onRemove?: () => void }) {
  if (!bill) return null;
  const { splitMode, splits, amount, payers, items } = bill;
  const getMemberShare = (m: string) => {
    if (splitMode === "equal") return amount / members.length;
    if (splitMode === "percent") return (splits[m] || 0) / 100 * amount;
    if (splitMode === "adjust") { const base = amount / members.length; return base + (splits[m] || 0); }
    if (splitMode === "itemized") {
      let share = 0;
      items?.forEach(it => {
        if (it.assignedTo && it.assignedTo.length > 0) {
          if (it.assignedTo.includes(m)) {
            share += it.price / it.assignedTo.length;
          }
        } else {
          share += it.price / members.length;
        }
      });
      const allocated = items?.reduce((sum, it) => sum + (it.price || 0), 0) || 0;
      const remaining = amount - allocated;
      if (remaining > 0.01) {
        share += remaining / members.length;
      }
      return share;
    }
    return 0;
  };
  const payerEntries = Object.entries(payers).filter(([_, amt]) => (amt || 0) > 0);

  return (
    <Modal onClose={onClose}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
        <div style={{ width: 46, height: 46, borderRadius: 13, background: "#ede9fe", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22 }}>🧾</div>
        <div>
          <div style={{ fontWeight: 800, fontSize: 16 }}>{bill.desc}</div>
          <div style={{ fontSize: 11, color: "#94a3b8" }}>{timeAgo(bill.ts)} · {splitMode === "equal" ? "Chia đều" : splitMode === "percent" ? "Theo %" : splitMode === "itemized" ? "Chia theo món" : "Có điều chỉnh"}</div>
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
            <Av name={name} size={34} ci={members.indexOf(name)} avatar={bill.memberDetails?.[name]?.avatar} />
            <div style={{ flex: 1 }}><div style={{ fontWeight: 700, fontSize: 13 }}>{name}</div></div>
            <span style={{ fontWeight: 800, fontSize: 14, color: "#7c3aed" }}>{fmt(amt)}</span>
          </div>
        ))}
      </div>

      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#dc2626", textTransform: "uppercase", letterSpacing: 1, marginBottom: 7 }}>Phân chia</div>
        {members.map((m, i) => {
          const share = getMemberShare(m);
          const paid = payers[m] || 0;
          const diff = paid - share;
          return (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 9, background: diff >= 0 ? "#f0fdf4" : "#fef2f2", borderRadius: 11, padding: "9px 13px", marginBottom: 5, border: `1.5px solid ${diff >= 0 ? "#bbf7d0" : "#fecaca"}` }}>
              <Av name={m} size={32} ci={members.indexOf(m)} avatar={bill.memberDetails?.[m]?.avatar} />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{m}</div>
                <div style={{ fontSize: 10, display: "flex", alignItems: "center", gap: 4 }}>
                  <span style={{ fontWeight: 900, color: diff >= 0 ? "#16a34a" : "#dc2626", background: diff >= 0 ? "#dcfce7" : "#fee2e2", padding: "1px 4px", borderRadius: 4, fontSize: 9 }}>{diff >= 0 ? "💰 ĐÃ DƯ" : "🔴 CÒN NỢ"}</span>
                  <span style={{ color: "#64748b" }}>{fmt(Math.abs(diff))}</span>
                </div>
              </div>
              <span style={{ fontWeight: 800, fontSize: 13, color: diff >= 0 ? "#16a34a" : "#dc2626" }}>{fmt(share)}</span>
            </div>
          );
        })}
      </div>

      {splitMode === "itemized" && items && items.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#475569", textTransform: "uppercase", letterSpacing: 1, marginBottom: 7 }}>Chi tiết món</div>
          <div style={{ background: "#f8fafc", borderRadius: 12, padding: "10px 12px", border: "1px solid #e2e8f0" }}>
            {items.map((it, idx) => (
              <div key={idx} style={{ padding: "8px 0", borderBottom: idx === items.length - 1 ? "none" : "1px solid #e2e8f0" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontWeight: 600 }}>
                  <span style={{ fontSize: 13, color: "#1e293b", flex: 1, paddingRight: 10 }}>{it.name}</span>
                  <span style={{ color: "#ec4899", fontSize: 13, whiteSpace: "nowrap" }}>{fmt(it.price || 0)}</span>
                </div>
                <div style={{ fontSize: 11, color: "#64748b", marginTop: 4 }}>
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

function AddExpenseModal({ members, memberDetails, onAdd, onClose }: { members: string[], memberDetails?: any, onAdd: (e: Expense) => void, onClose: () => void }) {
  const [desc, setDesc] = useState("");
  const [amount, setAmount] = useState("");
  const [payers, setPayers] = useState<Record<string, number>>({});
  const [mode, setMode] = useState("equal");
  const [splits, setSplits] = useState<Record<string, number>>({});
  
  const [items, setItems] = useState<ReceiptItem[]>([]);
  const [isScanning, setIsScanning] = useState(false);

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

  const payerVals = Object.values(payers) as number[];
  const totalPaid = payerVals.reduce((s: number, v: number) => s + (v || 0), 0);

  const updateSplit = (m: string, val: string) => setSplits(s => ({ ...s, [m]: parseFloat(val) || 0 }));

  const totalPct = members.reduce((s: number, m: string) => s + (splits[m] || 0), 0);
  const totalAdj = members.reduce((s: number, m: string) => s + (splits[m] || 0), 0);

  const valid = desc.trim() && amt > 0 && Math.abs(totalPaid - amt) < 1 && (
    mode === "equal" ||
    (mode === "percent" && Math.abs(totalPct - 100) < 0.01) ||
    (mode === "adjust" && Math.abs(totalAdj) < 0.01) ||
    mode === "itemized"
  );

  const handleAdd = () => {
    if (!valid) return;
    const expData: any = { id: String(Date.now()), desc: desc.trim(), amount: amt, payers: { ...payers }, splitMode: mode, splits: { ...splits }, ts: Date.now() };
    if (mode === "itemized") expData.items = items;
    onAdd(expData);
    onClose();
  };

  const scanReceipt = async (file: File) => {
    setIsScanning(true);
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

  return (
    <Modal onClose={onClose}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 44, height: 44, borderRadius: 13, background: "#dbeafe", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22 }}>🧾</div>
          <div style={{ fontWeight: 800, fontSize: 16, color: "#1e1e2e" }}>Thêm Khoản Chi</div>
        </div>
        <div style={{ display: "flex", gap: 5 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6, background: "linear-gradient(135deg,#ec4899,#f43f5e)", color: "#fff", padding: "6px 10px", borderRadius: 8, fontSize: 11, fontWeight: 700, cursor: "pointer", boxShadow: "0 2px 5px rgba(236,72,153,0.3)" }}>
             {isScanning ? <Loader2 size={14} className="animate-spin"/> : <Camera size={14}/>}
             {isScanning ? "Đang quét..." : "Chụp AI"}
             <input type="file" accept="image/*" capture="environment" onChange={(e) => { if(e.target.files?.[0]) scanReceipt(e.target.files[0]); }} style={{ display: "none" }} />
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6, background: "#f8fafc", border: "1px solid #cbd5e1", color: "#64748b", padding: "6px 10px", borderRadius: 8, fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
             {isScanning ? <Loader2 size={14} className="animate-spin"/> : <Upload size={14}/>}
             Ảnh
             <input type="file" accept="image/*" onChange={(e) => { if(e.target.files?.[0]) scanReceipt(e.target.files[0]); }} style={{ display: "none" }} />
          </label>
        </div>
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
                  <Av name={m} size={30} ci={i} avatar={memberDetails?.[m]?.avatar} />
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
            {[["equal", "⚖️ Đều"], ["percent", "📊 %"], ["adjust", "🔧 Adj"], ["itemized", "🍔 Món"]].map(([v, l]) => (
              <button key={v} onClick={() => setMode(v)} style={{ flex: 1, padding: "7px 4px", border: "none", borderRadius: 8, background: mode === v ? "#7c3aed" : "transparent", color: mode === v ? "#fff" : "#64748b", fontWeight: 700, fontSize: 11, cursor: "pointer", whiteSpace: "nowrap" }}>{l}</button>
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

        {mode === "itemized" && (
           <div style={{ background: "#f8fafc", borderRadius: 12, padding: "10px 12px" }}>
            {items.length === 0 && <div style={{fontSize: 12, color: "#94a3b8", textAlign: "center", padding: 10}}>Bấm nút "Quét AI" ở trên để phân tích hóa đơn, hoặc chọn kiểu chia khác.</div>}
            {items.map((it, idx) => (
              <div key={idx} style={{marginBottom: 12, padding: "10px", border: "1px solid #e2e8f0", borderRadius: 10, background: "#fff"}}>
                <div style={{display: "flex", justifyContent: "space-between", fontWeight: 600, marginBottom: 8}}>
                  <span style={{fontSize: 13, color: "#1e293b"}}>{it.name}</span>
                  <span style={{color: "#ec4899", fontSize: 13}}>{fmt(it.price || 0)}</span>
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
                    <Av name={m} size={26} ci={i} avatar={memberDetails?.[m]?.avatar}/><span style={{ flex: 1, fontSize: 12, fontWeight: 600 }}>{m}</span>
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
                    <Av name={m} size={26} ci={i} avatar={memberDetails?.[m]?.avatar}/><span style={{ flex: 1, fontSize: 12, fontWeight: 600 }}>{m}</span>
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

function PayModal({ members, memberDetails, transactions, onPay, onClose }: { members: string[], memberDetails?: any, transactions: any[], onPay: (p: Payment) => void, onClose: () => void }) {
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
              <Av name={m} size={22} ci={i} avatar={memberDetails?.[m]?.avatar}/><span style={{fontSize:12,fontWeight:600,color:from===m?"#7c3aed":"#374151"}}>{m}</span>
            </button>
          ))}
        </div>
      </div>
      <div style={{marginBottom:10}}>
        <div style={{fontSize:11,fontWeight:700,color:"#64748b",textTransform:"uppercase",marginBottom:6}}>Người nhận</div>
        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
          {members.filter(m=>m!==from).map((m,i)=>(
            <button key={i} onClick={()=>{setTo(m);const s=transactions.find(t=>t.from===from&&t.to===m);if(s)setAmount(Math.round(s.amount).toString());}} style={{display:"flex",alignItems:"center",gap:5,padding:"5px 10px 5px 5px",borderRadius:18,border:`2px solid ${to===m?"#059669":"#e2e8f0"}`,background:to===m?"#f0fdf4":"#fff",cursor:"pointer"}}>
              <Av name={m} size={22} ci={members.indexOf(m)} avatar={memberDetails?.[m]?.avatar}/><span style={{fontSize:12,fontWeight:600,color:to===m?"#059669":"#374151"}}>{m}</span>
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
  const [newInviteEmail, setNewInviteEmail] = useState("");
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const isLeader = group.leaderUid ? group.leaderUid === auth.currentUser?.uid : group.leader === currentUser;
  const inviteCode = group.inviteCode;
  const [copiedCode, setCopiedCode] = useState(false);

  useEffect(() => {
    const unsub = onSnapshot(query(collection(db, "invitations"), where("groupId", "==", group.id)), (snap) => {
      setInvitations(snap.docs.map(d => ({ ...d.data(), id: d.id } as Invitation)));
    }, err => handleFirestoreError(err, OperationType.LIST, "invitations"));
    return unsub;
  }, [group.id]);

  const copyCode = () => { navigator.clipboard.writeText(inviteCode); setCopiedCode(true); setTimeout(() => setCopiedCode(false), 2000); };
  
  const sendInvite = async () => {
    const email = newInviteEmail.trim();
    if (!email || !email.includes("@")) return;
    if (email === auth.currentUser?.email) {
      alert("Bạn không thể mời chính mình!");
      return;
    }
    try {
      const invDoc = await addDoc(collection(db, "invitations"), {
        groupId: group.id,
        inviterName: auth.currentUser?.displayName || "Trưởng nhóm",
        email,
        ts: Date.now()
      });
      sendEmailInvite(email, auth.currentUser?.displayName || "Bạn", group.name, invDoc.id);
      setNewInviteEmail("");
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, "invitations");
    }
  };

  const removeInvite = async (id: string) => {
    try {
      await deleteDoc(doc(db, "invitations", id));
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `invitations/${id}`);
    }
  };

  const getInviteLink = (id: string) => {
    return `${window.location.origin}/?inviteId=${id}`;
  };

  const copyLink = (id: string) => {
    navigator.clipboard.writeText(getInviteLink(id));
    alert("Đã sao chép link mời!");
  };

  return (
    <Modal onClose={onClose}>
      <div style={{fontWeight:800,fontSize:16,marginBottom:16,color:"#1e1e2e"}}>⚙️ Cài đặt nhóm</div>
      <Card style={{background:"#f5f3ff",marginBottom:10}}>
        <SecTitle icon="🔗" title="Mã mời" color="#7c3aed"/>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <div style={{flex:1,background:"#ede9fe",borderRadius:9,padding:"10px 14px",fontWeight:800,fontSize:18,color:"#7c3aed",letterSpacing:3,textAlign:"center"}}>{inviteCode}</div>
          <button onClick={copyCode} style={{background:copiedCode?"#059669":"#7c3aed",color:"#fff",border:"none",borderRadius:9,padding:"10px 14px",fontWeight:700,fontSize:12,cursor:"pointer"}}>{copiedCode?"✅ Đã sao chép":"📋 Sao chép"}</button>
        </div>
      </Card>
      <Card style={{marginBottom:10}}>
        <SecTitle icon="👥" title="Thành viên nhóm" color="#2563eb"/>
        <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:12}}>
          {group.members.map((m,i)=>(
            <div key={i} style={{display:"flex",alignItems:"center",gap:8,background:"#f8fafc",padding:"8px 10px",borderRadius:10}}>
              <Av name={m} size={28} ci={group.members.indexOf(m)} avatar={group.memberDetails?.[m]?.avatar}/>
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
        
        <div style={{ fontWeight: 700, fontSize: 12, color: "#64748b", marginBottom: 8 }}>LỜI MỜI ĐANG CHỜ ({invitations.length})</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
          {invitations.map((inv) => (
            <div key={inv.id} style={{ display: "flex", alignItems: "center", gap: 8, background: "#fdf2f8", padding: "8px 10px", borderRadius: 10, border: "1px solid #fecaca" }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#be185d" }}>{inv.email}</div>
                <div style={{ fontSize: 10, color: "#fb7185" }}>Chờ chấp nhận · {timeAgo(inv.ts)}</div>
              </div>
              <button onClick={() => copyLink(inv.id)} style={{ background: "#be185d", color: "#fff", border: "none", padding: "4px 8px", borderRadius: 6, fontSize: 10, fontWeight: 700, cursor: "pointer" }}>Link</button>
              {isLeader && <button onClick={() => removeInvite(inv.id)} style={{ background: "none", border: "none", color: "#dc2626", fontSize: 16, cursor: "pointer" }}>×</button>}
            </div>
          ))}
          {invitations.length === 0 && <div style={{ fontSize: 11, color: "#94a3b8", textAlign: "center" }}>Không có lời mời nào đang chờ.</div>}
        </div>

        <div style={{ fontWeight: 700, fontSize: 12, color: "#64748b", marginBottom: 8 }}>MỜI NHANH TỪ BẠN BÈ</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", maxHeight: 80, overflowY: "auto", background: "#f8fafc", padding: 8, borderRadius: 8, border: "1px solid #e2e8f0", marginBottom: 15 }}>
          {friends.filter(f => f.email && !group.members.includes(f.name) && !invitations.some(inv => inv.email === f.email)).map((f, i) => (
            <button key={i} onClick={() => { setNewInviteEmail(f.email || ""); }} style={{ display: "flex", alignItems: "center", gap: 5, padding: "4px 8px", borderRadius: 12, border: "1px solid #7c3aed", background: "#fff", cursor: "pointer", fontSize: 11, fontWeight: 600, color: "#7c3aed" }}>
              {f.name} ({f.email})
            </button>
          ))}
          {friends.filter(f => f.email && !group.members.includes(f.name)).length === 0 && <div style={{ fontSize: 10, color: "#94a3b8" }}>Không có bạn bè nào có email để mời nhanh.</div>}
        </div>

        <div style={{ fontWeight: 700, fontSize: 12, color: "#64748b", marginBottom: 8 }}>MỜI THÀNH VIÊN MỚI QUA EMAIL</div>
        <div style={{ display: "flex", gap: 8 }}>
          <Input placeholder="Nhập email..." value={newInviteEmail} onChange={(e: any) => setNewInviteEmail(e.target.value)} style={{ fontSize: 13, flex: 1 }} />
          <Btn onClick={sendInvite} style={{ fontSize: 13 }}>Gửi</Btn>
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
                    <Av name={m} size={20} ci={i} avatar={group.memberDetails?.[m]?.avatar}/>
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

function EmailSettingsModal({ prefs, onUpdate, onClose }: { prefs: UserPrefs, onUpdate: (p: Partial<UserPrefs>) => void, onClose: () => void }) {
  return (
    <Modal onClose={onClose}>
      <SecTitle icon="📨" title="Thông báo Email" color="#7c3aed" />
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
                  width: 44, height: 24, borderRadius: 12, background: (prefs as any)[item.id] ? "#7c3aed" : "#e2e8f0",
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

function ReceiptScannerView({ groups, onAddExpense }: { groups: Group[], onAddExpense: (groupId: string, e: Expense) => void }) {
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
      alert("Không thể mở camera. Vui lòng kiểm tra quyền truy cập. Thử mở ứng dụng trong thẻ mới (Open in new tab).");
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
    return <div style={{padding: 40, textAlign: "center", color: "#64748b"}}>Bạn cần tham gia ít nhất 1 nhóm để quét hóa đơn.</div>;
  }

  return (
    <div style={{padding: "20px 14px", paddingBottom: 100, maxWidth: 500, margin: "0 auto"}}>
      <SecTitle icon="📷" title="Quét Hóa Đơn AI" color="#ec4899" />
      
      {step === 1 && (
        <Card>
          <div style={{fontWeight: 700, fontSize: 13, marginBottom: 10}}>Chọn nhóm thanh toán:</div>
          <select value={groupId} onChange={e=>setGroupId(e.target.value)} style={{width: "100%", padding: 10, borderRadius: 10, border: "2px solid #e2e8f0", marginBottom: 20, outline: "none"}}>
            <option value="">-- Chọn nhóm --</option>
            {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>

          {groupId && !isCameraLive && (
             <div style={{display: "flex", flexDirection: "column", gap: 10}}>
                <button onClick={startCamera} style={{display: "flex", alignItems: "center", justifyContent: "center", gap: 10, padding: 15, background: "linear-gradient(135deg,#ec4899,#f43f5e)", border: "none", color: "#fff", borderRadius: 12, cursor: "pointer", fontWeight: 700}}>
                   <Camera size={20} />
                   Quét trực tiếp (Camera)
                </button>
                <label style={{display: "flex", alignItems: "center", justifyContent: "center", gap: 10, padding: 15, background: "#f8fafc", color: "#64748b", border: "2px dashed #cbd5e1", borderRadius: 12, cursor: "pointer", fontWeight: 700}}>
                   <Upload size={20} />
                   Tải ảnh lên
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
              <span style={{fontSize: 18}}>{total.toLocaleString()}đ</span>
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
                  <span style={{color: "#ec4899"}}>{(it.price || 0).toLocaleString()}đ</span>
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
      await addDoc(collection(db, "groups", group.id, "expenses"), { 
        ...data, 
        createdBy: auth.currentUser?.uid,
        memberDetails: group.memberDetails || {} 
      });
      await addDoc(collection(db, "groups", group.id, "feed"), {
        type: "expense",
        text: `${mainPayer} đã thêm "${exp.desc}" — ${fmt(exp.amount)}`,
        ts: Date.now(),
        icon: "🧾",
        name: mainPayer
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `groups/${group.id}/expenses`);
    }
  };

  const removeExpense = async (id: string) => {
    try {
      await deleteDoc(doc(db, "groups", group.id, "expenses", id));
      alert("✅ Đã xóa hóa đơn!");
      return true;
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `groups/${group.id}/expenses/${id}`);
      return false;
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
      {selectedBill && (
        <BillDetailModal 
          bill={selectedBill} 
          members={members} 
          onClose={() => setSelectedBill(null)} 
        />
      )}
      {showAddExp&&<AddExpenseModal members={members} memberDetails={group.memberDetails} onAdd={addExpense} onClose={()=>setShowAddExp(false)}/>}
      {showPay&&<PayModal members={members} memberDetails={group.memberDetails} transactions={transactions} onPay={addPayment} onClose={()=>setShowPay(false)}/>}
      {showSettings&&<GroupSettingsModal group={group} friends={friends} currentUser={auth.currentUser?.displayName || ""} onClose={()=>setShowSettings(false)} onUpdate={onUpdate} onLeave={onLeave} onDelete={onDelete}/>}

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
                  <Av name={t.from} size={32} ci={members.indexOf(t.from)} avatar={group.memberDetails?.[t.from]?.avatar}/>
                  <div style={{flex:1,fontSize:13,fontWeight:700}}><span style={{color:"#dc2626"}}>{t.from}</span> <span style={{color:"#fff", fontWeight: 900, padding: "2px 8px", background: "#ef4444", borderRadius: 12, fontSize: 10, margin: "0 4px"}}>NỢ</span> <span style={{color:"#059669"}}>{t.to}</span></div>
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
                    <div style={{fontWeight:800,fontSize:14}}>{e.desc}</div>
                    <div style={{fontSize:11,color:"#7c3aed",fontWeight:600}}>
                      {Object.keys(e.payers).filter(k => (e.payers[k] || 0) > 0).join(", ")}
                    </div>
                  </div>
                  <div style={{textAlign:"right"}}><div style={{fontWeight:800,fontSize:13,color:"#db2777"}}>{fmt(e.amount)}</div></div>
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
                    <Av name={m} size={42} ci={i} avatar={group.memberDetails?.[m]?.avatar} />
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
        <div style={{ fontSize: 13, fontWeight: 800, color: friendBalances.netBalance >= 0 ? "#16a34a" : "#dc2626", textTransform: "uppercase", marginBottom: 6 }}>
          {friendBalances.netBalance >= 0 ? "💰 ĐANG DƯ" : "🔴 ĐANG NỢ"}
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

function FriendsView({ friends, groups, onAddFriend, onRemoveFriend, onPayClick }: { friends: Friend[], groups: Group[], onAddFriend: (f: Friend) => void, onRemoveFriend: (id: string) => void, onPayClick: (g: Group) => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [selectedFriend, setSelectedFriend] = useState<Friend | null>(null);
  const [activeTab, setActiveTab] = useState<"list" | "pending">("list");

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
      {selectedFriend && <FriendActionModal friend={selectedFriend} groups={groups} onClose={() => setSelectedFriend(null)} onPay={(g) => { setSelectedFriend(null); onPayClick(g); }} />}
      
      <Card style={{ padding: "18px", marginBottom: 20 }}>
        <SecTitle icon="👥" title="Thêm bạn mới" color="#7c3aed" />
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <Input placeholder="Họ và tên..." value={name} onChange={(e: any) => setName(e.target.value)} />
          <Input placeholder="Địa chỉ email (không bắt buộc)..." value={email} onChange={(e: any) => setEmail(e.target.value)} />
          <div style={{ fontSize: 11, color: "#64748b", marginTop: -4, marginLeft: 4 }}>* Nhập email để gửi lời mời, hoặc để trống để thêm vào danh sách ngay.</div>
          <Btn onClick={add} style={{ marginTop: 4, background: "linear-gradient(135deg,#7c3aed,#a78bfa)" }}>✨ {email.trim() ? "Gửi lời mời" : "Thêm ngay"}</Btn>
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
            color: activeTab === "list" ? "#7c3aed" : "rgba(255,255,255,0.8)",
            boxShadow: activeTab === "list" ? "0 4px 12px rgba(0,0,0,0.1)" : "none",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6
          }}
        >
          <span>👥 Bạn bè</span>
          <span style={{ fontSize: 10, background: activeTab === "list" ? "#7c3aed" : "rgba(255,255,255,0.2)", color: "#fff", padding: "1px 6px", borderRadius: 8 }}>{acceptedFriends.length}</span>
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
            color: activeTab === "pending" ? "#7c3aed" : "rgba(255,255,255,0.8)",
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
                <Av name={f.name} size={42} ci={i} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, fontSize: 14 }}>{f.name}</div>
                  {f.email && <div style={{ fontSize: 11, color: "#94a3b8" }}>✉️ {f.email}</div>}
                </div>
                <button onClick={(e) => { e.stopPropagation(); if(confirm("Xóa người bạn này?") && f.id) onRemoveFriend(f.id); }} style={{ background: "#fef2f2", border: "none", color: "#dc2626", borderRadius: 8, width: 32, height: 32, cursor: "pointer", fontWeight: 700, fontSize: 16 }}>×</button>
              </div>
            </Card>
          ))}
          {acceptedFriends.length === 0 && <div style={{ textAlign: "center", padding: "40px 20px", color: "rgba(255,255,255,0.6)", fontSize: 14 }}>Bạn chưa có người bạn nào.</div>}
        </>
      ) : (
        <>
          {pendingFriends.map((f, i) => (
            <Card key={f.id || i} style={{ padding: "12px 14px", marginBottom: 7, opacity: 0.9 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <Av name={f.name} size={42} ci={i + acceptedFriends.length} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, fontSize: 14, color: "#64748b" }}>{f.name}</div>
                  <div style={{ fontSize: 11, color: "#94a3b8", display: "flex", alignItems: "center", gap: 6 }}>
                    <span>✉️ {f.email}</span>
                  </div>
                </div>
                <button onClick={(e) => { e.stopPropagation(); if(confirm("Hủy lời mời này?") && f.id) onRemoveFriend(f.id); }} style={{ background: "#fef2f2", border: "none", color: "#dc2626", borderRadius: 8, width: 32, height: 32, cursor: "pointer", fontWeight: 700, fontSize: 16 }}>×</button>
              </div>
            </Card>
          ))}
          {pendingFriends.length === 0 && <div style={{ textAlign: "center", padding: "40px 20px", color: "rgba(255,255,255,0.6)", fontSize: 14 }}>Không có lời mời nào đang chờ.</div>}
        </>
      )}
    </div>
  );
}

function GroupsListView({ groups, friends, onSelectGroup, onCreateGroup }: { groups: Group[], friends: Friend[], onSelectGroup: (g: Group) => void, onCreateGroup: (g: Group, invites: string[]) => void, onJoinGroup: () => void }) {
  const [showCreate,setShowCreate] = useState(false);
  const [showJoin,setShowJoin] = useState(false);
  const [gName,setGName] = useState(""); const [gEmoji,setGEmoji] = useState("🎉");
  const [emails,setEmails] = useState<string[]>([]);
  const [joinCode,setJoinCode] = useState("");

  const toggleEmail = (email: string) => setEmails(s=>s.includes(email)?s.filter(x=>x!==email):[...s,email]);

  const createGroup = () => {
    if(!gName.trim()) {
      alert("Vui lòng nhập tên nhóm!");
      return;
    }
    onCreateGroup({
      id:String(Date.now()),
      name:gName.trim(),
      emoji:gEmoji,
      members:[], // Members will be added as they accept invitations
      memberUids:[],
      leader: auth.currentUser?.displayName || "Trưởng nhóm",
      leaderUid: auth.currentUser?.uid || "",
      expenses:[],
      payments:[],
      feed:[{id:String(Date.now()),type:"group",text:`Nhóm "${gName.trim()}" được tạo`,ts:Date.now(),icon:"🎉"}],
      inviteCode:genCode(),
      dueDate:""
    }, emails);
    setGName("");setEmails([]);setShowCreate(false);
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
          <Input placeholder="Tên nhóm..." value={gName} onChange={(e: any)=>setGName(e.target.value)} style={{marginBottom:15}}/>
          
          <div style={{fontWeight:700,fontSize:12,color:"#64748b",marginBottom:8}}>MỜI NHANH TỪ BẠN BÈ</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", maxHeight: 80, overflowY: "auto", background: "#f8fafc", padding: 8, borderRadius: 8, border: "1px solid #e2e8f0", marginBottom: 15 }}>
            {friends.filter(f => f.email && !emails.includes(f.email)).map((f, i) => (
              <button key={i} onClick={() => { setEmails([...emails, f.email!]); }} style={{ display: "flex", alignItems: "center", gap: 5, padding: "4px 8px", borderRadius: 12, border: "1px solid #7c3aed", background: "#fff", cursor: "pointer", fontSize: 11, fontWeight: 600, color: "#7c3aed" }}>
                {f.name} ({f.email})
              </button>
            ))}
            {friends.filter(f => f.email && !emails.includes(f.email)).length === 0 && <div style={{ fontSize: 10, color: "#94a3b8" }}>Không có bạn bè mới có email để mời nhanh.</div>}
          </div>

          <div style={{fontWeight:700,fontSize:12,color:"#64748b",marginBottom:8}}>MỜI BẠN BÈ QUA EMAIL ({emails.length})</div>
          <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:12,maxHeight:150,overflowY:"auto",background:"#f8fafc",padding:10,borderRadius:12,border:"1px solid #e2e8f0"}}>
            {emails.map((email, i) => (
              <div key={i} style={{display:"flex",alignItems:"center",justifyContent:"space-between",background:"#fff",padding:"8px 12px",borderRadius:10,border:"1px solid #f1f5f9"}}>
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <div style={{width:24,height:24,borderRadius:"50%",background:"#ede9fe",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12}}>📧</div>
                  <span style={{fontSize:13,fontWeight:600}}>{email}</span>
                </div>
                <button onClick={() => toggleEmail(email)} style={{background:"none",border:"none",color:"#dc2626",fontSize:18,cursor:"pointer"}}>×</button>
              </div>
            ))}
            {emails.length === 0 && <div style={{fontSize:11,color:"#94a3b8",textAlign:"center",padding:10}}>Chưa có lời mời nào. Thêm email bên dưới!</div>}
          </div>

          <div style={{display:"flex",gap:6,marginBottom:15}}>
            <Input 
              placeholder="Nhập email người bạn..." 
              id="new-member-email"
              onKeyDown={(e: any) => {
                if (e.key === "Enter") {
                  const val = e.target.value.trim();
                  if (val && !emails.includes(val) && val.includes("@")) {
                    setEmails([...emails, val]);
                    e.target.value = "";
                  }
                }
              }}
              style={{fontSize:13, flex:1}}
            />
            <button 
              onClick={() => {
                const input = document.getElementById("new-member-email") as HTMLInputElement;
                const val = input?.value.trim();
                if (val && !emails.includes(val) && val.includes("@")) {
                  setEmails([...emails, val]);
                  input.value = "";
                }
              }}
              style={{background:"#7c3aed",color:"#fff",border:"none",borderRadius:10,padding:"0 15px",fontWeight:700,fontSize:18,cursor:"pointer"}}
            >+</button>
          </div>

          <div style={{fontSize:11, color:"#94a3b8", marginBottom:15, fontStyle:"italic"}}>* Hệ thống sẽ gửi email mời tham gia nhóm tới tất cả địa chỉ trên sau khi bạn tạo nhóm.</div>

          <Btn onClick={createGroup} style={{width:"100%", padding:"14px", fontSize: 14}}>✨ Tạo nhóm ngay</Btn>
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
          onClick={() => setShowCreate(true)} 
          style={{flex:1,background:"linear-gradient(135deg,#7c3aed,#a78bfa)",color:"#fff",border:"none",borderRadius:12,padding:"11px",fontWeight:700,fontSize:13,cursor:"pointer"}}
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

interface UserProfile {
  uid: string;
  name: string;
  avatar: string;
  email: string;
  createdAt: number;
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
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [userPrefs, setUserPrefs] = useState<UserPrefs>(DEFAULT_PREFS);
  const [groups, setGroups] = useState<Group[]>([]);
  const [friends, setFriends] = useState<Friend[]>([]);
  const [pendingInvites, setPendingInvites] = useState<Invitation[]>([]);
  const [activeGroup, setActiveGroup] = useState<Group | null>(null);
  const [loading, setLoading] = useState(true);
  const [inviteId, setInviteId] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get("inviteId");
    if (id) setInviteId(id);
  }, []);
  
  // Security & Profile state (Passcode might need to be in Firestore too, but let's keep it simple for now)
  const [passcode, setPasscode] = useState("");
  const [isLocked, setIsLocked] = useState(false);
  const [enteredPass, setEnteredPass] = useState("");
  const [profilePic, setProfilePic] = useState<string | null>(null);
  const [showEmailSettings, setShowEmailSettings] = useState(false);

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
              name: data.name || u.displayName || "Bạn",
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

  const deleteAccount = async () => {
    const currentUser = auth.currentUser;
    if (!currentUser) {
      alert("Không tìm thấy phiên đăng nhập. Vui lòng đăng nhập lại.");
      return;
    }

    const confirm = window.confirm("⚠️ CẢNH BÁO TỐI CAO: BẠN SẮP XÓA VĨNH VIỄN TÀI KHOẢN!\n\nHành động này sẽ XÓA SẠCH:\n1. Hồ sơ và danh sách bạn bè\n2. Các nhóm do bạn làm trưởng nhóm (bao gồm tất cả hóa đơn bên trong)\n3. Thông tin đăng nhập của bạn\n\nBạn có chắc chắn 100% muốn xóa toàn bộ dữ liệu và tài khoản này không? (Không thể khôi phục!)");
    if (!confirm) return;

    alert("⚙️ Hệ thống đang bắt đầu xóa toàn bộ dữ liệu của bạn... Vui lòng không đóng trình duyệt.");

    try {
      setLoading(true);
      // 1. Delete friends
      const friendsSnap = await getDocs(collection(db, "users", currentUser.uid, "friends"));
      for (const d of friendsSnap.docs) await deleteDoc(d.ref);
      
      // 2. Delete groups where user is leader
      const groupsSnap = await getDocs(query(collection(db, "groups"), where("leaderUid", "==", currentUser.uid)));
      for (const d of groupsSnap.docs) {
        // Delete subcollections first (expenses, payments, feed)
        const subcoll = ["expenses", "payments", "feed"];
        for (const sc of subcoll) {
          const snap = await getDocs(collection(db, "groups", d.id, sc));
          for (const sd of snap.docs) await deleteDoc(sd.ref);
        }
        await deleteDoc(d.ref);
      }

      // 3. Delete invitations sent by user
      const invitesSnap = await getDocs(query(collection(db, "invitations"), where("email", "==", currentUser.email)));
      for (const d of invitesSnap.docs) await deleteDoc(d.ref);

      // 4. Delete user doc
      await deleteDoc(doc(db, "users", currentUser.uid));
      
      // 5. Delete auth user (might require recent login)
      const email = currentUser.email;
      await currentUser.delete();
      alert(`Tài khoản (${email}) và toàn bộ dữ liệu đã được xóa sạch khỏi hệ thống!`);
      window.location.reload();
    } catch (err: any) {
      setLoading(false);
      if (err.code === 'auth/requires-recent-login') {
        alert("🔒 Vì lý do bảo mật, bạn cần đăng nhập lại trước khi xóa tài khoản.");
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
      setFriends(snap.docs.map(d => ({ ...d.data(), id: d.id } as Friend)));
    }, err => handleFirestoreError(err, OperationType.LIST, "friends"));

    // Sync groups where user is a member
    const groupsRef = collection(db, "groups");
    const groupsQuery = query(groupsRef, where("memberUids", "array-contains", user.uid));
    const unsubGroups = onSnapshot(groupsQuery, (snap) => {
      setGroups(snap.docs.map(d => ({ ...d.data(), id: d.id } as any)));
    }, err => handleFirestoreError(err, OperationType.LIST, "groups"));

    // Sync pending invitations for current user email
    let unsubInvites = () => {};
    if (user.email) {
      const invitesRef = collection(db, "invitations");
      const invitesQuery = query(invitesRef, where("email", "==", user.email));
      unsubInvites = onSnapshot(invitesQuery, (snap) => {
        setPendingInvites(snap.docs.map(d => ({ ...d.data(), id: d.id } as Invitation)));
      }, err => handleFirestoreError(err, OperationType.LIST, "pending invitations"));
    }

    return () => {
      unsubFriends();
      unsubGroups();
      unsubInvites();
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
    if (!user || !profile) return;
    if (f.email === user.email) {
      alert("Bạn không thể tự mời chính mình!");
      return;
    }
    try {
      await addDoc(collection(db, "users", user.uid, "friends"), f);
      if (f.email) {
        console.log(`[FRIEND INVITE SIMULATION] To: ${f.email} | Body: ${profile.name} invited you to join HappyShare!`);
        // In a real app, send actual email here
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, "friends");
    }
  };

  const removeFriend = async (id: string) => {
    if (!user) return;
    try {
      await deleteDoc(doc(db, "users", user.uid, "friends", id));
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

  const createGroup = async (g: any, invites: string[]) => {
    if (!user || !profile) return;
    const filteredInvites = invites.filter(e => e !== user.email);
    try {
      const groupData = {
        ...g,
        members: [profile.name],
        memberUids: [user.uid],
        leader: profile.name,
        leaderUid: user.uid,
        createdBy: user.uid,
        createdAt: serverTimestamp()
      };
      delete groupData.id;

      const docRef = await addDoc(collection(db, "groups"), groupData);
      
      // Create Invitations
      for (const email of filteredInvites) {
        const invDoc = await addDoc(collection(db, "invitations"), {
          groupId: docRef.id,
          inviterName: profile.name,
          email,
          ts: Date.now()
        });
        sendEmailInvite(email, profile.name, g.name, invDoc.id);
      }

      // Add initial feed
      await addDoc(collection(db, "groups", docRef.id, "feed"), {
        type: "group",
        text: `Nhóm "${g.name}" được tạo`,
        ts: Date.now(),
        icon: "🎉"
      });

      setActiveGroup({ ...groupData, id: docRef.id, leaderUid: user.uid });
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

  const addExpenseToGroup = async (groupId: string, exp: any) => {
    try {
      const g = groups.find(x => x.id === groupId);
      const { id, ...data } = exp;
      await addDoc(collection(db, "groups", groupId, "expenses"), { 
        ...data, 
        createdBy: auth.currentUser?.uid,
        memberDetails: g?.memberDetails || {}
      });
      const mainPayer = Object.keys(exp.payers).find(k => (exp.payers[k] || 0) > 0) || "Ai đó";
      await addDoc(collection(db, "groups", groupId, "feed"), {
        type: "expense",
        text: `${mainPayer} đã quét hoá đơn "${exp.desc}" — ${fmt(exp.amount)}`,
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

  if (inviteId) {
    return (
      <JoinGroupView 
        inviteId={inviteId} 
        profile={profile}
        onJoined={(g) => {
          setInviteId(null);
          setActiveGroup(g);
          setTab("active");
          // Clear URL params
          window.history.replaceState({}, document.title, window.location.pathname);
        }} 
      />
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
    <div style={{minHeight:"100vh",display:"flex",flexDirection:"column",background:"linear-gradient(135deg,#4c1d95 0%,#7c3aed 40%,#a78bfa 100%)"}}>
      {showOnboarding && (
        <Modal onClose={() => {}}>
          <div style={{ textAlign: "center", padding: "20px 0" }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>👋</div>
            <div style={{ fontWeight: 900, fontSize: 20, marginBottom: 8, color: "#1e293b" }}>Chào mừng bạn!</div>
            <div style={{ fontSize: 14, color: "#64748b", marginBottom: 24 }}>Vui lòng hoàn tất hồ sơ để bắt đầu sử dụng.</div>
            
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#475569", textAlign: "left", marginBottom: 6 }}>Tên hiển thị</div>
              <input 
                placeholder="Nhập tên của bạn..." 
                defaultValue={user?.displayName || ""} 
                id="onboarding-name"
                style={{ width: "100%", padding: "12px", borderRadius: 10, border: "1px solid #e2e8f0", background: "#fff", outline: "none" }}
              />
            </div>

            <div style={{ marginBottom: 24 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#475569", textAlign: "left", marginBottom: 12 }}>Chọn Avatar</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 10, justifyContent: "center" }}>
                {["🐱", "🐶", "🦊", "🐻", "🐼", "🦁", "🐧", "🦄"].map(av => (
                  <button 
                    key={av}
                    onClick={() => {
                      const btns = document.querySelectorAll('.av-choice');
                      btns.forEach(b => (b as HTMLElement).style.border = "2px solid #f1f5f9");
                      const btn = document.getElementById(`av-${av}`);
                      if (btn) btn.style.border = "2px solid #7c3aed";
                      (window as any)._selectedAvatar = av;
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
        {tab==="groups"&& (
          <>
            {pendingInvites.length > 0 && (
              <div style={{ padding: "12px 14px 0" }}>
                <div style={{ fontWeight: 800, fontSize: 13, color: "rgba(255,255,255,0.9)", marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
                  <span>💌 LỜI MỜI MỚI ({pendingInvites.length})</span>
                  <div style={{ flex: 1, height: 1, background: "rgba(255,255,255,0.2)" }} />
                </div>
                {pendingInvites.map(inv => (
                  <Card key={inv.id} style={{ padding: "12px 14px", marginBottom: 8, background: "rgba(255,255,255,0.95)", borderLeft: "4px solid #db2777" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <div style={{ width: 40, height: 40, borderRadius: 12, background: "#fce7f3", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20 }}>🧧</div>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 12, color: "#64748b" }}><b>{inv.inviterName}</b> mời bạn tham gia</div>
                        <div style={{ fontWeight: 800, fontSize: 14, color: "#be185d" }}>Nhóm chi tiêu mới</div>
                      </div>
                      <Btn onClick={() => setInviteId(inv.id)} style={{ padding: "6px 12px", fontSize: 12, background: "#db2777" }}>Xem & Tham gia</Btn>
                    </div>
                  </Card>
                ))}
              </div>
            )}
            <GroupsListView groups={groups} friends={friends} onSelectGroup={selectGroup} onCreateGroup={createGroup} onJoinGroup={()=>{}}/>
          </>
        )}
        {tab==="active"&&activeGroup&&(
          <GroupView group={groups.find(g=>g.id===activeGroup.id)||activeGroup} friends={friends} onUpdate={updateGroup} onDelete={()=>deleteGroup(activeGroup)} onLeave={()=>leaveGroup(activeGroup)} onBack={() => setTab("groups")}/>
        )}
        {tab==="friends"&&<FriendsView friends={friends} groups={groups} onAddFriend={addFriend} onRemoveFriend={removeFriend} onPayClick={(g) => selectGroup(g)}/>}
        {tab==="qr" && <ReceiptScannerView groups={groups} onAddExpense={addExpenseToGroup} />}
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
                 <div 
                   onClick={() => setShowEmailSettings(true)} 
                   style={{display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", padding: "10px 0"}}
                 >
                   <div style={{fontSize:12, fontWeight:700, color:"#64748b", textTransform:"uppercase", letterSpacing:1}}>Thông báo Email</div>
                 </div>
               </div>
            </Card>

            {showEmailSettings && <EmailSettingsModal prefs={userPrefs} onUpdate={updatePrefs} onClose={() => setShowEmailSettings(false)} />}

            {/* Hệ thống */}
            <Card>
               <SecTitle icon="🚪" title="Hệ thống" color="#374151"/>
               <div style={{display:"flex", gap:8}}>
                 <Btn onClick={logout} color="#374151" style={{flex:1, fontSize:12, padding:"10px"}}>Đăng xuất</Btn>
                 <Btn 
                   onClick={() => {
                     console.log("Delete account button clicked");
                     deleteAccount();
                   }}
                   color="#fecaca" 
                   style={{flex:1, color:"#991b1b", fontSize:11, border:"1.5px solid #dc2626"}}
                 >
                   🗑️ Xóa Vĩnh Viễn TK
                 </Btn>
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
