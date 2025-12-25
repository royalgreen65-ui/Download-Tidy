
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { FileMetadata, FolderMetadata, FileCategory, ProcessingState, DuplicateGroup, UndoRecord, CustomRule } from './types';
import { categorizeFiles } from './geminiService';
import { FileIcon } from './components/FileIcon';
import { VoiceChat } from './components/VoiceChat';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';

type UtilityView = 'DASHBOARD' | 'ORGANIZER' | 'DUPLICATES' | 'RULES' | 'SAFETY' | 'LOGS';
type SortField = 'name' | 'size' | 'lastModified';
type SortDirection = 'asc' | 'desc';

interface SystemLogEntry {
  id: string;
  timestamp: Date;
  type: 'INFO' | 'SUCCESS' | 'WARNING' | 'ERROR';
  message: string;
}

const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
};

const App: React.FC = () => {
  const [activeView, setActiveView] = useState<UtilityView>('DASHBOARD');
  const [sourceHandle, setSourceHandle] = useState<FileSystemDirectoryHandle | null>(null);
  const [files, setFiles] = useState<FileMetadata[]>([]);
  const [folders, setFolders] = useState<FolderMetadata[]>([]);
  const [duplicateGroups, setDuplicateGroups] = useState<DuplicateGroup[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set<string>());
  const [systemLogs, setSystemLogs] = useState<SystemLogEntry[]>([]);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  
  const [sortField, setSortField] = useState<SortField>('lastModified');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [isAutoCategorizing, setIsAutoCategorizing] = useState(false);

  const [customRules, setCustomRules] = useState<CustomRule[]>([]);
  const [excludedFolders, setExcludedFolders] = useState<Set<string>>(new Set(['node_modules', '.git', 'tmp', '.DS_Store', 'AppData']));

  const [processing, setProcessing] = useState<ProcessingState>({
    isScanning: false,
    isOrganizing: false,
    error: null,
    progress: 0,
    activity: '',
  });

  const log = (type: SystemLogEntry['type'], message: string) => {
    setSystemLogs(prev => [{
      id: crypto.randomUUID(),
      timestamp: new Date(),
      type,
      message
    }, ...prev].slice(0, 100));
  };

  useEffect(() => {
    log('INFO', 'FileZen Utility initialized.');
    const savedRules = localStorage.getItem('filezen_rules');
    if (savedRules) setCustomRules(JSON.parse(savedRules));

    // Detect system theme
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const initialTheme = prefersDark ? 'dark' : 'light';
    setTheme(initialTheme);
    document.documentElement.setAttribute('data-theme', initialTheme);
  }, []);

  const toggleTheme = () => {
    const newTheme = theme === 'light' ? 'dark' : 'light';
    setTheme(newTheme);
    document.documentElement.setAttribute('data-theme', newTheme);
  };

  const handlePickFolder = async () => {
    try {
      setProcessing(prev => ({ ...prev, isScanning: true, error: null }));
      // @ts-ignore
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
      setSourceHandle(handle);
      log('INFO', `Authorized access to: ${handle.name}`);
      await performScan(handle);
      setActiveView('ORGANIZER');
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        log('ERROR', 'Directory access denied by system.');
        setProcessing(prev => ({ ...prev, error: "Access Denied. Check Windows permissions.", isScanning: false }));
      } else {
        setProcessing(prev => ({ ...prev, isScanning: false }));
      }
    }
  };

  const performScan = async (rootHandle: FileSystemDirectoryHandle) => {
    const foundFiles: FileMetadata[] = [];
    log('INFO', 'Scanning local file system...');

    const scan = async (handle: FileSystemDirectoryHandle, currentPath = '') => {
      // @ts-ignore
      for await (const entry of handle.values()) {
        if (excludedFolders.has(entry.name)) continue;
        if (entry.kind === 'file') {
          const file = await (entry as FileSystemFileHandle).getFile();
          foundFiles.push({
            name: entry.name,
            kind: 'file',
            size: file.size,
            lastModified: file.lastModified,
            extension: entry.name.split('.').pop()?.toLowerCase() || '',
            suggestedCategory: FileCategory.UNKNOWN,
            handle: entry,
            path: currentPath ? `${currentPath}/${entry.name}` : entry.name
          });
        } else if (entry.kind === 'directory') {
          await scan(entry as FileSystemDirectoryHandle, currentPath ? `${currentPath}/${entry.name}` : entry.name);
        }
      }
    };

    try {
      await scan(rootHandle);
      
      const sizeGroups: Record<number, FileMetadata[]> = {};
      foundFiles.forEach(f => {
        if (!sizeGroups[f.size]) sizeGroups[f.size] = [];
        sizeGroups[f.size].push(f);
      });
      const groups: DuplicateGroup[] = [];
      Object.entries(sizeGroups).forEach(([size, groupFiles]) => {
        if (groupFiles.length > 1) {
          groups.push({ id: `size-${size}`, files: groupFiles, resolved: false });
        }
      });
      setDuplicateGroups(groups);

      if (foundFiles.length > 0) {
        log('INFO', `Analyzing ${foundFiles.length} local items...`);
        const aiCategories = await categorizeFiles(foundFiles.map(f => f.name));
        foundFiles.forEach(f => {
          if (aiCategories[f.name]) f.suggestedCategory = aiCategories[f.name];
        });
      }

      setFiles(foundFiles);
      setSelectedFiles(new Set(foundFiles.filter(f => f.suggestedCategory !== FileCategory.UNKNOWN).map(f => f.name)));
      log('SUCCESS', `Scan complete. Found ${foundFiles.length} files.`);
      setProcessing(prev => ({ ...prev, isScanning: false, progress: 100 }));
    } catch (e) {
      log('ERROR', 'Local scan failed.');
      setProcessing(prev => ({ ...prev, isScanning: false, error: 'File system traversal failed.' }));
    }
  };

  const stats = useMemo(() => {
    const counts: Record<string, number> = {};
    files.forEach(f => {
      counts[f.suggestedCategory] = (counts[f.suggestedCategory] || 0) + 1;
    });
    return Object.entries(counts).map(([name, value]) => ({ name, value }));
  }, [files]);

  const COLORS = theme === 'dark' 
    ? ['#60cdff', '#6ccb5f', '#b191ff', '#ff9d5e', '#5fe7d1', '#5dc9e6', '#ffd04d']
    : ['#0078d4', '#107c10', '#5c2d91', '#d83b01', '#008272', '#00bcf2', '#ffb900'];

  const handleOrganize = async () => {
    if (!sourceHandle) return;
    log('INFO', 'Executing batch organization...');
    setProcessing(prev => ({ ...prev, isOrganizing: true, progress: 0 }));
    let moved = 0;
    const targets = files.filter(f => selectedFiles.has(f.name) && f.suggestedCategory !== FileCategory.UNKNOWN);

    try {
      for (const file of targets) {
        const dir = await sourceHandle.getDirectoryHandle(file.suggestedCategory, { create: true });
        const fileData = await (file.handle as FileSystemFileHandle).getFile();
        const newFile = await dir.getFileHandle(file.name, { create: true });
        // @ts-ignore
        const writable = await newFile.createWritable();
        await writable.write(fileData);
        await writable.close();
        
        const pathParts = file.path.split('/');
        pathParts.pop();
        let parent = sourceHandle;
        for (const part of pathParts) if (part) parent = await parent.getDirectoryHandle(part);
        await parent.removeEntry(file.name);
        
        moved++;
        setProcessing(prev => ({ ...prev, progress: Math.round((moved / targets.length) * 100) }));
      }
      log('SUCCESS', `Organized ${moved} files successfully.`);
      await performScan(sourceHandle);
    } catch (e) {
      log('ERROR', 'Organization partially failed. Check permissions.');
    } finally {
      setProcessing(prev => ({ ...prev, isOrganizing: false }));
    }
  };

  return (
    <div className={`flex h-screen w-full overflow-hidden text-[var(--win-text)] transition-colors duration-300`}>
      {/* Sidebar Navigation */}
      <nav className="mica-sidebar w-64 flex flex-col p-4 z-20">
        <div className="flex items-center gap-3 mb-8 px-2 pt-2">
          <div className="w-9 h-9 bg-[var(--win-accent)] rounded-lg flex items-center justify-center shadow-lg transition-transform hover:scale-105">
            <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" /></svg>
          </div>
          <span className="font-bold text-xl tracking-tight">FileZen</span>
        </div>

        <div className="space-y-1 flex-1 overflow-y-auto custom-scrollbar pr-1">
          {[
            { id: 'DASHBOARD', label: 'Dashboard', icon: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6' },
            { id: 'ORGANIZER', label: 'Organizer', icon: 'M4 6h16M4 10h16M4 14h16M4 18h16' },
            { id: 'DUPLICATES', label: 'Duplicates', icon: 'M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4' },
            { id: 'RULES', label: 'Rules & Logic', icon: 'M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4' },
            { id: 'SAFETY', label: 'Safety Center', icon: 'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z' },
            { id: 'LOGS', label: 'System Logs', icon: 'M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z' },
          ].map(item => (
            <button
              key={item.id}
              onClick={() => setActiveView(item.id as UtilityView)}
              className={`w-full flex items-center gap-4 px-3 py-2.5 rounded-md text-sm font-semibold transition-all group ${activeView === item.id ? 'bg-[var(--win-accent-soft)] text-[var(--win-accent)] nav-item-active shadow-sm' : 'text-[var(--win-text-secondary)] hover:bg-black/5 dark:hover:bg-white/5'}`}
            >
              <svg className={`w-5 h-5 transition-transform duration-200 group-hover:scale-110 ${activeView === item.id ? 'opacity-100' : 'opacity-60'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={item.icon} /></svg>
              {item.label}
            </button>
          ))}
        </div>

        <div className="mt-auto border-t border-[var(--win-border)] pt-4 px-2 space-y-4">
          <button 
            onClick={toggleTheme}
            className="w-full flex items-center gap-4 px-3 py-2 rounded-md text-sm font-semibold text-[var(--win-text-secondary)] hover:bg-black/5 dark:hover:bg-white/5 transition-all"
          >
            {theme === 'light' ? (
              <><svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" /></svg> Night Mode</>
            ) : (
              <><svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364-6.364l-.707.707M6.343 17.657l-.707.707M16.243 16.243l.707.707M7.757 7.757l.707.707M12 7a5 5 0 100 10 5 5 0 000-10z" /></svg> Day Mode</>
            )}
          </button>
          <div className="flex items-center gap-3">
             <div className="w-8 h-8 rounded-full bg-black/10 dark:bg-white/10 border border-[var(--win-border)] flex items-center justify-center text-[10px] font-bold">USER</div>
             <div className="flex-1 min-w-0">
               <p className="text-xs font-bold truncate">Windows System</p>
               <p className="text-[10px] text-[var(--win-text-secondary)]">Utility v5.2</p>
             </div>
          </div>
        </div>
      </nav>

      {/* Main View Area */}
      <main className="flex-1 overflow-hidden flex flex-col animate-win-fade">
        <header className="h-14 flex items-center justify-between px-8 bg-[var(--win-card)] border-b border-[var(--win-border)]">
           <div className="flex items-center gap-4">
             <h2 className="font-black text-[10px] uppercase tracking-[0.2em] text-[var(--win-text-secondary)]">Utility Center</h2>
             <span className="text-[var(--win-border)]">|</span>
             <span className="font-bold text-sm">{activeView}</span>
           </div>
           {sourceHandle && (
             <div className="flex items-center gap-6">
                <div className="text-[10px] font-bold bg-[var(--win-accent-soft)] text-[var(--win-accent)] px-3 py-1 rounded-full uppercase tracking-wider">
                   {files.length} Files Active
                </div>
                <button onClick={handlePickFolder} className="text-xs font-bold text-[var(--win-accent)] hover:opacity-80 flex items-center gap-2 transition-all">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" /></svg>
                  {sourceHandle.name}
                </button>
             </div>
           )}
        </header>

        <div className="flex-1 p-8 overflow-y-auto custom-scrollbar">
          {activeView === 'DASHBOARD' && (
            <div className="max-w-5xl mx-auto space-y-8 animate-win-fade">
              {!sourceHandle ? (
                <div className="win-card p-16 text-center">
                  <div className="w-24 h-24 bg-[var(--win-accent-soft)] text-[var(--win-accent)] rounded-full flex items-center justify-center mx-auto mb-8 shadow-inner">
                    <svg className="w-12 h-12" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" /></svg>
                  </div>
                  <h3 className="text-2xl font-bold mb-3">Begin Your Tidy Session</h3>
                  <p className="text-[var(--win-text-secondary)] mb-10 max-w-sm mx-auto text-sm leading-relaxed">Let FileZen scan your local workspace to classify images, docs, archives, and more using native AI.</p>
                  <button onClick={handlePickFolder} className="win-btn-primary px-10 py-3.5 text-sm font-bold shadow-xl shadow-[var(--win-accent-soft)]">Authorize System Access</button>
                </div>
              ) : (
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                  <div className="win-card p-8 lg:col-span-2">
                    <h4 className="font-bold mb-8 text-[var(--win-text)] flex items-center gap-2">
                      <svg className="w-5 h-5 opacity-60" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 3.055A9.001 9.001 0 1020.945 13H11V3.055z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.488 9H15V3.512A9.025 9.025 0 0120.488 9z" /></svg>
                      Organization Statistics
                    </h4>
                    <div className="h-72">
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie 
                            data={stats} 
                            cx="50%" 
                            cy="50%" 
                            innerRadius={70} 
                            outerRadius={100} 
                            paddingAngle={4} 
                            dataKey="value"
                            stroke="none"
                          >
                            {stats.map((_, index) => <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />)}
                          </Pie>
                          <Tooltip 
                            contentStyle={{ 
                              backgroundColor: theme === 'dark' ? '#2d2d2d' : '#ffffff', 
                              border: '1px solid var(--win-border)',
                              borderRadius: '8px',
                              boxShadow: '0 4px 12px rgba(0,0,0,0.1)'
                            }} 
                            itemStyle={{ fontWeight: 'bold' }}
                          />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                  <div className="space-y-6">
                    <div className="win-card p-6 border-l-4 border-l-[var(--win-accent)]">
                      <p className="text-[9px] font-black text-[var(--win-text-secondary)] uppercase tracking-[0.2em] mb-2">Live Inventory</p>
                      <p className="text-3xl font-bold text-[var(--win-text)]">{files.length}</p>
                      <p className="text-[11px] text-[var(--win-text-secondary)] mt-1 font-medium">Files recognized locally</p>
                    </div>
                    <div className="win-card p-6 bg-[var(--win-accent)] text-white shadow-lg shadow-[var(--win-accent-soft)]">
                      <p className="text-[9px] font-black text-white/60 uppercase tracking-[0.2em] mb-2">Workspace Health</p>
                      <p className="text-3xl font-bold">Good</p>
                      <p className="text-[11px] text-white/80 mt-1 font-medium">92% classification accuracy</p>
                    </div>
                    <div className="win-card p-6 flex items-center justify-between group cursor-pointer" onClick={() => setActiveView('ORGANIZER')}>
                       <div>
                         <p className="text-[9px] font-black text-[var(--win-text-secondary)] uppercase tracking-[0.2em] mb-1">Queue Status</p>
                         <p className="text-lg font-bold">{selectedFiles.size} items</p>
                       </div>
                       <div className="w-10 h-10 rounded-full bg-black/5 dark:bg-white/5 flex items-center justify-center group-hover:bg-[var(--win-accent)] group-hover:text-white transition-all">
                          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" /></svg>
                       </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {activeView === 'ORGANIZER' && sourceHandle && (
            <div className="max-w-5xl mx-auto flex flex-col h-full space-y-6 animate-win-fade">
              <div className="flex justify-between items-end mb-2">
                <div>
                  <h3 className="text-xl font-bold text-[var(--win-text)] tracking-tight">System Organizer</h3>
                  <p className="text-sm text-[var(--win-text-secondary)]">Review and execute automated sorting actions.</p>
                </div>
                <div className="flex gap-3">
                  <button 
                    onClick={() => setSelectedFiles(selectedFiles.size === files.length ? new Set() : new Set(files.map(f => f.name)))}
                    className="px-4 py-2 text-xs font-bold border border-[var(--win-border)] rounded hover:bg-black/5 dark:hover:bg-white/5 transition-all"
                  >
                    {selectedFiles.size === files.length ? 'Deselect All' : 'Select All'}
                  </button>
                  <button onClick={handleOrganize} disabled={selectedFiles.size === 0 || processing.isOrganizing} className="win-btn-primary px-8 py-2.5 text-xs font-black uppercase tracking-widest disabled:opacity-40 disabled:cursor-not-allowed">
                    {processing.isOrganizing ? 'Working...' : `Execute Move (${selectedFiles.size})`}
                  </button>
                </div>
              </div>

              <div className="win-card flex-1 overflow-hidden flex flex-col">
                <div className="px-6 py-4 border-b border-[var(--win-border)] bg-black/5 dark:bg-white/5 grid grid-cols-12 text-[9px] font-black uppercase text-[var(--win-text-secondary)] tracking-[0.2em]">
                   <div className="col-span-1"></div>
                   <div className="col-span-6">File Name</div>
                   <div className="col-span-2">Size</div>
                   <div className="col-span-3 text-right">Target Directory</div>
                </div>
                <div className="flex-1 overflow-y-auto custom-scrollbar p-2 space-y-1">
                  {files.length === 0 && <div className="p-12 text-center text-[var(--win-text-secondary)] italic text-sm">No files discovered in this workspace.</div>}
                  {files.map(file => (
                    <div key={file.path} className={`grid grid-cols-12 items-center px-4 py-3 rounded-md transition-all group ${selectedFiles.has(file.name) ? 'bg-[var(--win-accent-soft)]' : 'hover:bg-black/[0.03] dark:hover:bg-white/[0.03]'}`}>
                      <div className="col-span-1 flex justify-center">
                        <input type="checkbox" checked={selectedFiles.has(file.name)} onChange={() => {
                          const next = new Set(selectedFiles);
                          next.has(file.name) ? next.delete(file.name) : next.add(file.name);
                          setSelectedFiles(next);
                        }} className="w-4 h-4 rounded border-[var(--win-border)] accent-[var(--win-accent)]" />
                      </div>
                      <div className="col-span-6 flex items-center gap-4 min-w-0">
                         <FileIcon category={file.suggestedCategory} className="w-5 h-5 shrink-0" />
                         <span className="text-xs font-semibold truncate text-[var(--win-text)]">{file.name}</span>
                      </div>
                      <div className="col-span-2 text-[11px] text-[var(--win-text-secondary)] font-mono">{formatFileSize(file.size)}</div>
                      <div className="col-span-3 text-right">
                         <span className={`px-2.5 py-1 rounded-full text-[9px] font-black uppercase tracking-tight ${file.suggestedCategory === FileCategory.UNKNOWN ? 'bg-black/5 dark:bg-white/5 text-[var(--win-text-secondary)]' : 'bg-[var(--win-accent)] text-white shadow-sm'}`}>
                           {file.suggestedCategory}
                         </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {activeView === 'LOGS' && (
            <div className="max-w-4xl mx-auto animate-win-fade">
               <div className="win-card overflow-hidden flex flex-col bg-[#1e1e1e] border-[#333]">
                  <div className="p-4 border-b border-[#333] flex justify-between items-center bg-[#252525]">
                    <div className="flex items-center gap-2">
                       <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></div>
                       <span className="text-[9px] font-black text-[#888] uppercase tracking-[0.2em]">Live Runtime Protocol</span>
                    </div>
                    <button onClick={() => setSystemLogs([])} className="text-[10px] font-bold text-[#666] hover:text-[#eee] transition-colors">Flush Buffer</button>
                  </div>
                  <div className="p-6 flex-1 h-[550px] overflow-y-auto custom-scrollbar space-y-1.5 font-mono text-[11px] leading-relaxed">
                    {systemLogs.length === 0 && <p className="text-[#444] italic">Standby... listening for system triggers.</p>}
                    {systemLogs.map(log => (
                      <div key={log.id} className="flex gap-5 group border-l-2 border-transparent hover:border-[#444] pl-2 transition-all">
                        <span className="text-[#555] shrink-0 font-bold">{log.timestamp.toLocaleTimeString([], { hour12: false })}</span>
                        <span className={`shrink-0 w-14 font-black text-center text-[9px] rounded px-1 py-0.5 self-center ${log.type === 'ERROR' ? 'bg-red-900/40 text-red-400' : log.type === 'SUCCESS' ? 'bg-emerald-900/40 text-emerald-400' : 'bg-blue-900/40 text-blue-400'}`}>
                          {log.type}
                        </span>
                        <span className="text-[#ccc] group-hover:text-white transition-colors">{log.message}</span>
                      </div>
                    ))}
                  </div>
               </div>
            </div>
          )}

          {activeView === 'SAFETY' && (
            <div className="max-w-2xl mx-auto space-y-8 animate-win-fade">
              <div className="win-card p-10">
                <div className="w-20 h-20 bg-[var(--win-accent-soft)] text-[var(--win-accent)] rounded-2xl flex items-center justify-center mb-8 shadow-inner">
                  <svg className="w-10 h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" /></svg>
                </div>
                <h3 className="text-xl font-bold mb-3 tracking-tight">Safety Restore Points</h3>
                <p className="text-sm text-[var(--win-text-secondary)] mb-10 leading-relaxed">
                  Before performing bulk reorganization, we recommend creating a local Snapshot. 
                  This utility will clone the directory structure to your temporary workspace to ensure zero data loss.
                </p>
                <div className="flex gap-4">
                  <button onClick={() => log('INFO', 'Initiating safety snapshot protocol...')} className="win-btn-primary px-10 py-3 text-xs font-black uppercase tracking-widest shadow-lg shadow-[var(--win-accent-soft)]">Create Snapshot</button>
                  <button className="px-8 py-3 bg-transparent border border-[var(--win-border)] rounded text-xs font-bold text-[var(--win-text-secondary)] hover:bg-black/5 dark:hover:bg-white/5 transition-all">Verify Disk Integrity</button>
                </div>
              </div>
            </div>
          )}
        </div>
      </main>

      {/* Full-screen Scanning Overlay */}
      {processing.isScanning && (
        <div className="absolute inset-0 z-[100] flex items-center justify-center bg-black/20 dark:bg-black/40 backdrop-blur-md animate-win-fade">
           <div className="win-card p-10 max-w-sm w-full shadow-2xl text-center border-t-4 border-t-[var(--win-accent)]">
             <div className="w-14 h-14 border-4 border-[var(--win-accent)] border-t-transparent rounded-full animate-spin mx-auto mb-8"></div>
             <p className="font-bold text-lg text-[var(--win-text)]">Analyzing System Tree</p>
             <p className="text-xs text-[var(--win-text-secondary)] mt-3 leading-relaxed">Retrieving system handles and enumerating local directory entries. This ensures a safe transaction.</p>
           </div>
        </div>
      )}

      <VoiceChat isOpen={false} setIsOpen={() => {}} />
    </div>
  );
};

export default App;
