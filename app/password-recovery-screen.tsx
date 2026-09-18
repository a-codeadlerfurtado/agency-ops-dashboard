"use client";

import { useState } from "react";
import { BrandMark, supabase } from "./shared";

export function PasswordRecoveryScreen({ onDone }: { onDone: () => void }) {
  const [password,setPassword]=useState("");
  const [confirm,setConfirm]=useState("");
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState("");

  async function submit(event:React.FormEvent<HTMLFormElement>){
    event.preventDefault();
    setMessage("");
    if(password.length<6){setMessage("A senha precisa ter pelo menos 6 caracteres.");return;}
    if(password!==confirm){setMessage("As senhas não conferem.");return;}
    setBusy(true);
    try{
      const {error}=await supabase.auth.updateUser({password});
      if(error)throw error;
      setMessage("Senha definida. Você já pode entrar com o novo acesso.");
      await supabase.auth.signOut({scope:"local"});
      window.setTimeout(onDone,700);
    }catch(error){
      setMessage(error instanceof Error?error.message:"Não foi possível definir a senha.");
    }finally{setBusy(false);}
  }

  return <main className="auth-shell"><aside className="auth-aside"><div className="auth-aside-mark"><BrandMark/></div><div className="auth-aside-word"><b>Leonardo Imobi</b><span>Growth Imobiliário</span></div><p className="auth-aside-note">Definição segura de acesso.</p></aside><section className="auth-card"><div className="auth-head"><span className="eyebrow">Central de Operações</span><h1>Defina sua nova senha</h1><p>Essa senha será usada para entrar no Dashboard.</p></div><form onSubmit={submit}><label>Nova senha<input type="password" autoComplete="new-password" required minLength={6} value={password} onChange={e=>setPassword(e.target.value)} placeholder="Mínimo de 6 caracteres"/></label><label>Confirmar senha<input type="password" autoComplete="new-password" required minLength={6} value={confirm} onChange={e=>setConfirm(e.target.value)} placeholder="Repita a senha"/></label>{message&&<p className="auth-message" role="status">{message}</p>}<button className="auth-submit" disabled={busy}>{busy?"Salvando…":"Salvar nova senha"}</button></form></section></main>;
}
