import { useEffect, useMemo, useState } from 'react'
import { Cloud, UploadCloud, File, FileText, Image, Archive, Download, History, RotateCcw, Trash2, LogOut, RefreshCw, ShieldCheck, HardDrive, X, AlertCircle, CheckCircle2 } from 'lucide-react'

const TOKEN_KEY = 'clouddrop_token'
const API = '/api'

function prettySize(bytes = 0) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}
function prettyDate(value) {
  if (!value) return '—'
  return new Date(value).toLocaleString()
}
function fileIcon(name = '') {
  const ext = name.split('.').pop()?.toLowerCase()
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return <Image size={18} />
  if (['zip', '7z', 'tar', 'gz'].includes(ext)) return <Archive size={18} />
  if (['pdf', 'txt', 'doc', 'docx', 'md'].includes(ext)) return <FileText size={18} />
  return <File size={18} />
}

async function request(path, options = {}, token = localStorage.getItem(TOKEN_KEY)) {
  const headers = { ...(options.headers || {}) }
  if (token) headers.Authorization = `Bearer ${token}`
  if (options.body && !(options.body instanceof FormData)) headers['Content-Type'] = 'application/json'
  const response = await fetch(`${API}${path}`, { ...options, headers })
  const data = response.status === 204 ? null : await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data?.detail || data?.message || `Request failed (${response.status})`)
  return data
}

export default function App() {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY))
  const [user, setUser] = useState(null)
  const [authMode, setAuthMode] = useState('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [files, setFiles] = useState([])
  const [versionsFor, setVersionsFor] = useState(null)
  const [versions, setVersions] = useState([])
  const [selectedFile, setSelectedFile] = useState(null)
  const [targetFileId, setTargetFileId] = useState('new')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState(null)
  const [dragging, setDragging] = useState(false)

  const activeFiles = files.filter(f => !f.deleted && f.status === 'ready')
  const storageUsed = useMemo(() => activeFiles.reduce((sum, f) => sum + (f.size_bytes || 0), 0), [activeFiles])

  function notify(text, type = 'success') {
    setMessage({ text, type })
    window.setTimeout(() => setMessage(null), 4500)
  }

  async function refreshFiles() {
    setLoading(true)
    try { setFiles(await request('/files')) }
    catch (error) { notify(error.message, 'error') }
    finally { setLoading(false) }
  }

  async function loadMeAndFiles(currentToken) {
    try {
      const me = await request('/auth/me', {}, currentToken)
      setUser(me)
      setFiles(await request('/files', {}, currentToken))
    } catch {
      localStorage.removeItem(TOKEN_KEY)
      setToken(null)
      setUser(null)
    }
  }

  useEffect(() => { if (token) loadMeAndFiles(token) }, [token])

  async function submitAuth(event) {
    event.preventDefault()
    setBusy(true)
    try {
      const data = await request(`/auth/${authMode === 'login' ? 'login' : 'register'}`, {
        method: 'POST', body: JSON.stringify({ email, password }),
      }, null)
      localStorage.setItem(TOKEN_KEY, data.access_token)
      setToken(data.access_token)
      setUser(data.user)
      setPassword('')
      notify(authMode === 'login' ? 'Welcome back!' : 'Account created successfully!')
    } catch (error) { notify(error.message, 'error') }
    finally { setBusy(false) }
  }

  function logout() {
    localStorage.removeItem(TOKEN_KEY)
    setToken(null); setUser(null); setFiles([]); setVersionsFor(null)
  }

  async function uploadFile(file, existingId = null) {
    if (!file) return
    setBusy(true)
    try {
      const presign = await request('/files/presign', {
        method: 'POST',
        body: JSON.stringify({ filename: file.name, content_type: file.type || 'application/octet-stream', size_bytes: file.size, existing_file_id: existingId || null }),
      })
      const putResponse = await fetch(presign.upload_url, {
        method: 'PUT', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file,
      })
      if (!putResponse.ok) throw new Error(`S3 upload failed (${putResponse.status}). Check the bucket CORS configuration.`)
      await request(`/files/${presign.file_id}/complete`, { method: 'POST' })
      notify(existingId ? 'New object version uploaded!' : 'File uploaded to S3!')
      setSelectedFile(null); setTargetFileId('new')
      await refreshFiles()
      if (versionsFor?.id === presign.file_id) await openVersions(files.find(f => f.id === presign.file_id) || { id: presign.file_id, filename: file.name })
    } catch (error) { notify(error.message, 'error') }
    finally { setBusy(false) }
  }

  async function openVersions(file) {
    setVersionsFor(file)
    try {
      const data = await request(`/files/${file.id}/versions`)
      setVersions(data.versions || [])
    } catch (error) { notify(error.message, 'error'); setVersionsFor(null) }
  }

  async function downloadFile(file, versionId = null) {
    try {
      const suffix = versionId ? `?version_id=${encodeURIComponent(versionId)}` : ''
      const data = await request(`/files/${file.id}/download${suffix}`)
      window.location.assign(data.download_url)
    } catch (error) { notify(error.message, 'error') }
  }

  async function restoreVersion(file, versionId) {
    if (!window.confirm('Restore this version? S3 will create a new latest version; the existing history will remain.')) return
    try {
      await request(`/files/${file.id}/restore`, { method: 'POST', body: JSON.stringify({ version_id: versionId }) })
      notify('Version restored as a new latest version.')
      await refreshFiles()
      await openVersions(file)
    } catch (error) { notify(error.message, 'error') }
  }

  async function deleteFile(file) {
    if (!window.confirm(`Delete ${file.filename}? S3 will create a delete marker; prior versions remain in the bucket.`)) return
    try {
      await request(`/files/${file.id}`, { method: 'DELETE' })
      notify('File deleted. Its previous S3 versions are retained.')
      await refreshFiles()
    } catch (error) { notify(error.message, 'error') }
  }

  function onDrop(event) {
    event.preventDefault(); setDragging(false)
    const file = event.dataTransfer.files?.[0]
    if (file) setSelectedFile(file)
  }

  if (!token || !user) return (
    <main className="auth-shell">
      <div className="auth-card">
        <div className="brand-mark"><Cloud size={25} /></div>
        <p className="eyebrow">AWS-POWERED FILE STORAGE</p>
        <h1>CloudDrop</h1>
        <p className="muted">Your files, safely stored and versioned in the cloud.</p>
        <div className="auth-tabs">
          <button className={authMode === 'login' ? 'active' : ''} onClick={() => setAuthMode('login')}>Sign in</button>
          <button className={authMode === 'register' ? 'active' : ''} onClick={() => setAuthMode('register')}>Create account</button>
        </div>
        <form onSubmit={submitAuth} className="auth-form">
          <label>Email address<input type="email" required autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" /></label>
          <label>Password<input type="password" minLength={10} required autoComplete={authMode === 'login' ? 'current-password' : 'new-password'} value={password} onChange={e => setPassword(e.target.value)} placeholder="At least 10 characters" /></label>
          <button className="primary full" disabled={busy}>{busy ? 'Please wait…' : authMode === 'login' ? 'Sign in' : 'Create account'}</button>
        </form>
        <p className="tiny muted">Passwords are hashed on the server. Files are stored in a private S3 bucket.</p>
      </div>
      {message && <Toast message={message} />}
    </main>
  )

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark small"><Cloud size={20}/></span><span>CloudDrop</span></div>
        <div className="top-actions"><span className="user-email">{user.email}</span><button className="icon-button" title="Sign out" onClick={logout}><LogOut size={18}/></button></div>
      </header>
      <main className="content-wrap">
        <section className="welcome-row"><div><p className="eyebrow">YOUR CLOUD WORKSPACE</p><h1>My files</h1><p className="muted">Upload, manage and restore file versions.</p></div><button className="secondary" onClick={refreshFiles} disabled={loading}><RefreshCw size={16}/> Refresh</button></section>
        <section className="stats-grid">
          <div className="stat-card"><div className="stat-icon blue"><File size={19}/></div><div><span className="stat-label">Total files</span><strong>{activeFiles.length}</strong></div></div>
          <div className="stat-card"><div className="stat-icon green"><HardDrive size={19}/></div><div><span className="stat-label">Current storage</span><strong>{prettySize(storageUsed)}</strong></div></div>
          <div className="stat-card"><div className="stat-icon violet"><ShieldCheck size={19}/></div><div><span className="stat-label">Storage</span><strong>Private S3 bucket</strong></div></div>
        </section>
        <section className="panel upload-panel">
          <div className="panel-heading"><div><h2>Upload a file</h2><p className="muted">Upload a new file or create a new version of an existing file.</p></div><UploadCloud size={22}/></div>
          <div className={`dropzone ${dragging ? 'dragging' : ''}`} onDragOver={e => { e.preventDefault(); setDragging(true) }} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
            <UploadCloud size={30}/><strong>{selectedFile ? selectedFile.name : 'Drag and drop a file here'}</strong><span className="muted">or choose a file from your computer · max 25 MB</span>
            <label className="file-picker">Choose file<input type="file" onChange={e => setSelectedFile(e.target.files?.[0] || null)}/></label>
          </div>
          <div className="upload-controls">
            <label className="select-label">Upload as<select value={targetFileId} onChange={e => setTargetFileId(e.target.value)}><option value="new">New file</option>{activeFiles.map(f => <option value={f.id} key={f.id}>New version of {f.filename}</option>)}</select></label>
            <button className="primary" disabled={!selectedFile || busy} onClick={() => uploadFile(selectedFile, targetFileId === 'new' ? null : targetFileId)}>{busy ? 'Uploading…' : targetFileId === 'new' ? 'Upload to S3' : 'Upload new version'}</button>
          </div>
        </section>
        <section className="panel files-panel">
          <div className="panel-heading"><div><h2>File library</h2><p className="muted">Your objects and their S3 version histories.</p></div><span className="count-pill">{files.length} items</span></div>
          {loading ? <div className="empty-state">Loading files…</div> : files.length === 0 ? <div className="empty-state"><Cloud size={32}/><strong>No files yet</strong><span>Upload your first file to get started.</span></div> : (
            <div className="table-scroll"><table><thead><tr><th>File</th><th>Size</th><th>Last updated</th><th>Status</th><th>Actions</th></tr></thead><tbody>
              {files.map(file => <tr key={file.id}>
                <td><div className="file-name">{fileIcon(file.filename)}<span>{file.filename}</span></div></td>
                <td>{prettySize(file.size_bytes)}</td><td>{prettyDate(file.updated_at)}</td>
                <td><span className={`status ${file.deleted ? 'deleted' : file.status}`}>{file.deleted ? 'Deleted' : file.status}</span></td>
                <td><div className="row-actions">{!file.deleted && <button title="Download latest" onClick={() => downloadFile(file)}><Download size={16}/></button>}<button title="Version history" onClick={() => openVersions(file)}><History size={16}/></button>{!file.deleted && <button className="danger-icon" title="Delete" onClick={() => deleteFile(file)}><Trash2 size={16}/></button>}</div></td>
              </tr>)}
            </tbody></table></div>
          )}
        </section>
        <footer><span>CloudDrop · Built with FastAPI, React and Amazon S3</span><span><ShieldCheck size={14}/> Private by design</span></footer>
      </main>
      {versionsFor && <div className="modal-backdrop" onClick={() => setVersionsFor(null)}><section className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head"><div><p className="eyebrow">S3 OBJECT VERSIONING</p><h2>{versionsFor.filename}</h2></div><button className="icon-button" onClick={() => setVersionsFor(null)}><X size={19}/></button></div>
        <p className="muted modal-desc">Each upload to the same S3 object key creates a separate version. Restoring an older version copies its contents into a new latest version.</p>
        {versions.length === 0 ? <div className="empty-state">No S3 versions found yet.</div> : <div className="version-list">{versions.map((v, index) => <div className="version-row" key={v.version_id || index}>
          <div className="version-main"><span className={`version-dot ${v.is_latest ? 'latest' : ''}`}></span><div><strong>{v.kind === 'delete_marker' ? 'Delete marker' : `Version ${versions.filter(x => x.kind === 'version').length - versions.filter(x => x.kind === 'version').findIndex(x => x.version_id === v.version_id)}`}{v.is_latest && <em>Latest</em>}</strong><small>{prettyDate(v.last_modified)}{v.kind === 'version' ? ` · ${prettySize(v.size_bytes)}` : ''}</small><code>{v.version_id}</code></div></div>
          {v.kind === 'version' && <div className="version-actions"><button title="Download this version" onClick={() => downloadFile(versionsFor, v.version_id)}><Download size={16}/></button><button title="Restore this version" onClick={() => restoreVersion(versionsFor, v.version_id)}><RotateCcw size={16}/></button></div>}
        </div>)}</div>}
        <div className="modal-foot"><span className="tiny muted">Version IDs are generated and managed by Amazon S3.</span><button className="secondary" onClick={() => openVersions(versionsFor)}><RefreshCw size={15}/> Refresh history</button></div>
      </section></div>}
      {message && <Toast message={message}/>}
    </div>
  )
}

function Toast({ message }) {
  return <div className={`toast ${message.type}`} role="status">{message.type === 'error' ? <AlertCircle size={17}/> : <CheckCircle2 size={17}/>}<span>{message.text}</span></div>
}
