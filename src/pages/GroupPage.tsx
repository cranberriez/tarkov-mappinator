import { useEffect, useState, type FormEvent } from "react";
import type { Group, GroupConnection } from "../lib/useGroup";
import { cleanName, CODE_LENGTH, NAME_MAX, normalizeCode, validName, type MemberStatus } from "../lib/group";
import { mapName } from "../maps";

const connectionText: Record<GroupConnection, string> = {
  off: "Share raid status and positions with friends.", checking: "Signing in…", "needs-key": "Needs an access key.",
  connecting: "Connecting…", online: "Connected", error: "Not connected",
};
const statusText: Record<MemberStatus, string> = { waiting: "Waiting", "in-raid": "In raid", "out-of-raid": "Out of raid" };

/** Group sync: on/off, the name others see, and creating, joining or showing the group you're in. */
export function GroupPage({ group, onShowMember }: { group: Group; onShowMember: (id: string) => void }) {
  const { enabled, connection, membership, error, code, members, self } = group;
  return <div className="page group-page">
    <header className="page-header"><h1>Group</h1></header>

    <button type="button" role="switch" aria-checked={enabled} className="switch-row group-toggle" onClick={() => group.setEnabled(!enabled)}>
      <span><strong>Group sync</strong><span className={`faint group-status ${connection}`}>{connectionText[connection]}</span></span>
      <span className={`switch ${enabled ? "on" : ""}`} aria-hidden="true" />
    </button>
    {error && <p className="group-error" role="alert">{error}</p>}

    {enabled && connection === "needs-key" && <AccessKeyForm group={group} />}

    {enabled && connection !== "needs-key" && <>
      <NameField group={group} />
      {code ? <section className="group-current">
        <div className="group-code-row">
          <span className="faint">Code</span>
          <CopyCode code={code} />
          <span className="faint">{membership === "joining" ? "Joining…" : membership === "error" ? "Couldn't join" : ""}</span>
          <button type="button" className="secondary group-leave" onClick={group.leave}>Leave</button>
        </div>
        <ul className="group-members">
          <li className="group-member self">
            <span className="dot" style={{ background: "var(--accent-strong)" }} />
            <span className="group-name">{group.name}<span className="faint"> (you)</span></span>
            <span className="faint">{self.inRaid ? `In raid${self.map ? ` · ${mapName(self.map) ?? self.map}` : ""}` : "Out of raid"}</span>
          </li>
          {members.map((member) => {
            const where = member.status === "in-raid" && member.map ? ` · ${mapName(member.map) ?? member.map}` : "";
            return <li key={member.id}>
              <button type="button" className="group-member" disabled={!member.map} title={member.map ? "Show on map" : undefined}
                onClick={() => onShowMember(member.id)}>
                <span className="dot" style={{ background: member.color }} />
                <span className="group-name">{member.name}</span>
                <span className="faint">{statusText[member.status]}{where}</span>
              </button>
            </li>;
          })}
          {membership === "joined" && !members.length && <li className="faint group-alone">Nobody else yet. Share the code.</li>}
        </ul>
      </section> : <JoinOrCreate group={group} online={connection === "online"} />}
    </>}
  </div>;
}

/** The name others see; saved on Enter or leaving the field (saving reconnects, so not per keystroke). */
function NameField({ group }: { group: Group }) {
  const [draft, setDraft] = useState(group.name);
  useEffect(() => setDraft(group.name), [group.name]);
  const commit = () => { if (validName(draft) && draft !== group.name) group.setName(draft); else setDraft(group.name); };
  return <div className="field group-name-field">
    <div className="field-label"><label htmlFor="group-name">Name</label><span className="faint">{draft.length}/{NAME_MAX}</span></div>
    <input id="group-name" value={draft} maxLength={NAME_MAX} spellCheck={false} autoComplete="off"
      onChange={(event) => setDraft(cleanName(event.target.value))} onBlur={commit}
      onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />
  </div>;
}

/** Only while connected: a group made or joined offline would look joined without anything behind it. */
function JoinOrCreate({ group, online }: { group: Group; online: boolean }) {
  const [joining, setJoining] = useState(false);
  const [typed, setTyped] = useState("");
  const code = normalizeCode(typed);
  const submit = (event: FormEvent) => { event.preventDefault(); if (code && online) group.join(code); };
  const offline = online ? undefined : "Not connected";
  if (!joining) return <div className="group-actions">
    <button type="button" className="primary" disabled={!online} title={offline} onClick={group.create}>Create group</button>
    <button type="button" className="secondary" disabled={!online} title={offline} onClick={() => setJoining(true)}>Join group</button>
  </div>;
  return <form className="group-actions" onSubmit={submit}>
    <input className="group-code-input" value={typed} placeholder="Code" maxLength={CODE_LENGTH + 2} autoFocus spellCheck={false} autoComplete="off"
      aria-label="Group code" onChange={(event) => setTyped(event.target.value.toUpperCase())} />
    <button type="submit" className="primary" disabled={!code || !online} title={offline}>Join</button>
    <button type="button" className="secondary" onClick={() => { setJoining(false); setTyped(""); }}>Cancel</button>
  </form>;
}

function AccessKeyForm({ group }: { group: Group }) {
  const [typed, setTyped] = useState(group.accessKey);
  return <form className="group-actions" onSubmit={(event) => { event.preventDefault(); group.setAccessKey(typed.trim()); }}>
    <input type="password" value={typed} placeholder="Access key" autoFocus autoComplete="off" aria-label="Access key"
      onChange={(event) => setTyped(event.target.value)} />
    <button type="submit" className="primary" disabled={!typed.trim()}>Connect</button>
  </form>;
}

function CopyCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (!copied) return; const timer = window.setTimeout(() => setCopied(false), 1500); return () => window.clearTimeout(timer); }, [copied]);
  return <button type="button" className="group-code" title="Copy code"
    onClick={() => void navigator.clipboard.writeText(code).then(() => setCopied(true), () => {})}>
    <strong>{code}</strong><span className="faint">{copied ? "Copied" : "Copy"}</span>
  </button>;
}
