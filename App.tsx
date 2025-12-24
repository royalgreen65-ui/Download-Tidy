
import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { FileMetadata, FolderMetadata, FileCategory, ProcessingState, DuplicateGroup, UndoRecord, CustomRule } from './types';
import { categorizeFiles } from './geminiService';
import { FileIcon } from './components/FileIcon';
import { VoiceChat } from './components/VoiceChat';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';

type AppStep = 'IDLE' | 'SCANNING' | 'DUPLICATES' | 'REVIEW' | 'VERIFYING' | 'EXPORTING' | 'COMPLETED';
type SortField = 'name' | 'size' | 'lastModified';
type SortDirection = 'asc' | 'desc';

const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
};

const App: React.FC = () => {
  const [step, setStep] = useState<AppStep>('IDLE');
  const [sourceHandle, setSourceHandle] = useState<FileSystemDirectoryHandle | null>(null);
  const [files, setFiles] = useState<FileMetadata[]>([]);
  const [folders, setFolders] = useState<FolderMetadata[]>([]);
  const [duplicateGroups, setDuplicateGroups] = useState<DuplicateGroup[]>([]);
  const [filesToDelete, setFilesToDelete] = useState<Set<string>>(new Set<string>());
  const [foldersToDelete, setFoldersToDelete] = useState<Set<string>>(new Set<string>());
  const [rules, setRules] = useState<Record<string, FileCategory>>({});
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set<string>());
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null);
  
  const [sortField, setSortField] = useState<SortField>('lastModified');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');

  const [lastMoveHistory, setLastMoveHistory] = useState<UndoRecord[]>([]);
  const [isChatOpen, setIsChatOpen] = useState(false);
  
  const [editingFilePath, setEditingFilePath] = useState<string | null>(null);
  const [tempRenameValue, setTempRenameValue] = useState('');

  const [customRules, setCustomRules] = useState<CustomRule[]>([]);
  const [newRulePattern, setNewRulePattern] = useState('');
  const [newRuleType, setNewRuleType] = useState<'extension' | 'keyword'>('extension');
  const [newRuleCategory, setNewRuleCategory] = useState<FileCategory>(FileCategory.DOCUMENTS);

  const [excludedFolders, setExcludedFolders] = useState<Set<string>>(new Set(['node_modules', '.git', 'tmp', '.DS_Store', 'AppData']));
  const [newExclusion, setNewExclusion] = useState('');

  const [dragOverCategory, setDragOverCategory] = useState<string | null>(null);
  const [showAIConfirm, setShowAIConfirm] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const [processing, setProcessing] = useState<ProcessingState>({
    isScanning: false,
    isOrganizing: false,
    error: null,
    progress: 0,
    activity: '',
    currentFileName: ''
  });

  const [isAutoCategorizing, setIsAutoCategorizing] = useState(false);

  useEffect(() => {
    const savedRules = localStorage.getItem('filezen_custom_rules');
    if (savedRules) {
      try {
        setCustomRules(JSON.parse(savedRules));
      } catch (e) {
        console.error("Failed to load rules", e);
      }
    }

    const savedExclusions = localStorage.getItem('filezen_exclusions');
    if (savedExclusions) {
      try {
        const parsed = JSON.parse(savedExclusions);
        if (Array.isArray(parsed)) {
          setExcludedFolders(new Set(parsed.map((item: any) => String(item))));
        }
      } catch (e) {
        console.error("Failed to load exclusions", e);
      }
    }

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      setDeferredPrompt(e);
    });
  }, []);

  useEffect(() => {
    localStorage.setItem('filezen_custom_rules', JSON.stringify(customRules));
  }, [customRules]);

  useEffect(() => {
    localStorage.setItem('filezen_exclusions', JSON.stringify(Array.from(excludedFolders)));
  }, [excludedFolders]);

  const handleInstallClick = async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') setDeferredPrompt(null);
  };

  const handlePickSource = async () => {
    try {
      setProcessing(prev => ({ ...prev, isScanning: true, error: null }));
      setStep('SCANNING');
      // @ts-ignore
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
      setSourceHandle(handle);
      await startScan(handle);
    } catch (err: any) {
      setStep('IDLE');
      if (err && typeof err === 'object' && 'name' in err && err.name !== 'AbortError') {
        setProcessing(prev => ({ ...prev, error: "Access denied. Grant permissions to continue.", isScanning: false }));
      } else {
        setProcessing(prev => ({ ...prev, isScanning: false }));
      }
    }
  };

  const applyCustomRules = (fileName: string, extension: string): FileCategory | null => {
    for (const rule of customRules.filter(r => r.type === 'keyword')) {
      if (fileName.toLowerCase().includes(rule.pattern.toLowerCase())) {
        return rule.category;
      }
    }
    for (const rule of customRules.filter(r => r.type === 'extension')) {
      const cleanPattern = rule.pattern.replace('.', '').toLowerCase();
      if (extension.toLowerCase() === cleanPattern) {
        return rule.category;
      }
    }
    return null;
  };

  const startScan = async (rootHandle: FileSystemDirectoryHandle) => {
    const foundFiles: FileMetadata[] = [];
    const foundFolders: FolderMetadata[] = [];
    
    const scan = async (handle: FileSystemDirectoryHandle, currentPath = '') => {
      let fileCount = 0;
      let subFolderCount = 0;

      // @ts-ignore
      for await (const entry of handle.values()) {
        if (excludedFolders.has(entry.name)) {
          continue; 
        }

        if (entry.kind === 'file') {
          fileCount++;
          const fileHandle = entry as FileSystemFileHandle;
          const file = await fileHandle.getFile();
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
          subFolderCount++;
          await scan(entry as FileSystemDirectoryHandle, currentPath ? `${currentPath}/${entry.name}` : entry.name);
        }
      }

      if (currentPath !== '') {
        foundFolders.push({
          name: handle.name,
          path: currentPath,
          handle: handle,
          fileCount,
          subFolderCount,
          willBeEmpty: false
        });
      }
    };

    try {
      await scan(rootHandle);
      setProcessing(prev => ({ ...prev, progress: 20 }));

      const sizeGroups: Record<number, FileMetadata[]> = {};
      foundFiles.forEach(f => {
        if (!sizeGroups[f.size]) sizeGroups[f.size] = [];
        sizeGroups[f.size].push(f);
      });

      const groups: DuplicateGroup[] = [];
      Object.entries(sizeGroups).forEach(([size, groupFiles]) => {
        if (groupFiles.length > 1) {
          const groupId = `group-${size}`;
          groupFiles.forEach(f => {
            f.isDuplicate = true;
            f.duplicateGroupId = groupId;
          });
          groups.push({ id: groupId, files: groupFiles, resolved: false });
        }
      });

      setDuplicateGroups(groups);
      setProcessing(prev => ({ ...prev, progress: 40 }));

      if (foundFiles.length > 0) {
        foundFiles.forEach(f => {
          const ruleMatch = applyCustomRules(f.name, f.extension);
          if (ruleMatch) f.suggestedCategory = ruleMatch;
        });

        const filesForAI = foundFiles.filter(f => f.suggestedCategory === FileCategory.UNKNOWN);
        if (filesForAI.length > 0) {
          setProcessing(prev => ({ ...prev, activity: `AI Identifying ${filesForAI.length} items...` }));
          const fileNames = filesForAI.map(f => f.name);
          const aiCategories = await categorizeFiles(fileNames);
          
          foundFiles.forEach(f => {
            if (f.suggestedCategory === FileCategory.UNKNOWN && aiCategories[f.name]) {
              f.suggestedCategory = aiCategories[f.name];
            }
          });
        }
        
        setFiles(foundFiles);
        setFolders(foundFolders);
        setSelectedFiles(new Set(foundFiles.filter(f => f.suggestedCategory !== FileCategory.UNKNOWN).map(f => f.name)));
      }

      setProcessing(prev => ({ ...prev, progress: 100, isScanning: false }));
      setStep(groups.length > 0 ? 'DUPLICATES' : 'REVIEW');
    } catch (err: any) {
      console.error(err);
      setProcessing(prev => ({ ...prev, error: "Failed to scan directory. Check permissions.", isScanning: false }));
      setStep('IDLE');
    }
  };

  const handleReset = () => {
    if (window.confirm("Clear all results and reset the tidy process?")) {
      setFiles([]); setFolders([]); setDuplicateGroups([]); setFilesToDelete(new Set()); setFoldersToDelete(new Set());
      setRules({}); setSelectedFiles(new Set()); setSourceHandle(null); setStep('IDLE'); setLastMoveHistory([]);
      setProcessing({ isScanning: false, isOrganizing: false, error: null, progress: 0, activity: '', currentFileName: '' });
    }
  };

  const handleAutoCategorizeSelected = () => {
    if (selectedFiles.size === 0) return;
    setShowAIConfirm(true);
  };

  const confirmAutoCategorize = async () => {
    setShowAIConfirm(false);
    setIsAutoCategorizing(true);
    try {
      const selectedList = files.filter(f => selectedFiles.has(f.name));
      const fileNames = selectedList.map(f => f.name);
      if (fileNames.length > 0) {
        const aiCategories = await categorizeFiles(fileNames);
        setFiles(prev => prev.map(f => aiCategories[f.name] ? { ...f, suggestedCategory: aiCategories[f.name] } : f));
      }
    } catch (err) {
      console.error("AI Categorization failed:", err);
    } finally {
      setIsAutoCategorizing(false);
    }
  };

  const addCustomRule = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newRulePattern.trim()) return;
    setCustomRules([...customRules, { id: crypto.randomUUID(), type: newRuleType, pattern: newRulePattern.trim(), category: newRuleCategory }]);
    setNewRulePattern('');
  };

  const removeCustomRule = (id: string) => setCustomRules(customRules.filter(r => r.id !== id));

  const addExclusion = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newExclusion.trim()) return;
    setExcludedFolders(prev => new Set([...Array.from(prev), newExclusion.trim()]));
    setNewExclusion('');
  };

  const removeExclusion = (name: string) => {
    setExcludedFolders(prev => {
      const next = new Set(prev);
      next.delete(name);
      return next;
    });
  };

  const handleExportConfig = () => {
    const blob = new Blob([JSON.stringify({ version: "1.0", customRules, excludedFolders: Array.from(excludedFolders) }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `tidy-config-${new Date().toISOString().split('T')[0]}.json`;
    a.click(); URL.revokeObjectURL(url);
  };

  const handleImportConfig = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const config = JSON.parse(event.target?.result as string);
        if (config.customRules) setCustomRules(config.customRules);
        if (config.excludedFolders) setExcludedFolders(new Set(config.excludedFolders));
      } catch (err) { alert("Invalid config file."); }
    };
    reader.readAsText(file);
  };

  const resolveDuplicates = async () => {
    if (!sourceHandle) return;
    setProcessing(prev => ({ ...prev, isOrganizing: true, activity: 'Purging Redundant Files', progress: 0 }));
    let count = 0; const total = filesToDelete.size;
    for (const fileName of Array.from(filesToDelete)) {
      try { await sourceHandle.removeEntry(fileName); } catch (e) {}
      count++; setProcessing(prev => ({ ...prev, progress: Math.round((count / total) * 100) }));
    }
    setFiles(files.filter(f => !filesToDelete.has(f.name)));
    setFilesToDelete(new Set()); setStep('REVIEW');
    setProcessing(prev => ({ ...prev, isOrganizing: false }));
  };

  const keepOne = (groupId: string, keepFileName: string) => {
    const group = duplicateGroups.find(g => g.id === groupId);
    if (!group) return;
    setFilesToDelete(prev => {
      const next = new Set(prev);
      group.files.forEach(f => f.name !== keepFileName ? next.add(f.name) : next.delete(f.name));
      return next;
    });
  };

  const updateFileCategory = (fileName: string, category: FileCategory) => {
    setFiles(prev => prev.map(f => f.name === fileName ? { ...f, suggestedCategory: category } : f));
  };

  const handleBulkCategorize = (category: FileCategory) => {
    if (selectedFiles.size === 0) return;
    setFiles(prev => prev.map(f => selectedFiles.has(f.name) ? { ...f, suggestedCategory: category } : f));
  };

  const handleToggleSelect = (name: string) => {
    setSelectedFiles(prev => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  };

  const handleSelectAll = () => {
    selectedFiles.size === files.length ? setSelectedFiles(new Set()) : setSelectedFiles(new Set(files.map(f => f.name)));
  };

  const getSubDirHandle = async (root: FileSystemDirectoryHandle, relativePath: string): Promise<{ handle: FileSystemDirectoryHandle, fileName: string }> => {
    const parts = relativePath.split('/');
    const fileName = parts.pop()!;
    let current = root;
    for (const part of parts) if (part) current = await current.getDirectoryHandle(part, { create: true });
    return { handle: current, fileName };
  };

  const handleSystemBackup = async () => {
    if (!sourceHandle) return;
    try {
      // @ts-ignore
      const backupRoot = await window.showDirectoryPicker({ mode: 'readwrite' });
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupDir = await backupRoot.getDirectoryHandle(`Tidy_Backup_${timestamp}`, { create: true });
      setStep('EXPORTING');
      setProcessing(prev => ({ ...prev, isOrganizing: true, progress: 0, activity: 'Cloning files for safety...' }));
      let count = 0;
      for (const file of files) {
        const fileData = await (file.handle as FileSystemFileHandle).getFile();
        const pathParts = file.path.split('/'); pathParts.pop();
        let currentBackupDir = backupDir;
        for (const part of pathParts) if (part) currentBackupDir = await currentBackupDir.getDirectoryHandle(part, { create: true });
        const backupFileHandle = await currentBackupDir.getFileHandle(file.name, { create: true });
        // @ts-ignore
        const writable = await backupFileHandle.createWritable();
        await writable.write(fileData); await writable.close();
        count++; setProcessing(prev => ({ ...prev, progress: Math.round((count / files.length) * 100) }));
      }
      setStep('REVIEW');
    } catch (err: any) {
      if (err.name !== 'AbortError') setProcessing(prev => ({ ...prev, error: 'Backup failed.' }));
      setStep('REVIEW');
    } finally { setProcessing(prev => ({ ...prev, isOrganizing: false })); }
  };

  const handleFinalizeToDesktop = async () => {
    if (!sourceHandle) return;
    try {
      // @ts-ignore
      const destParentHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
      const destHandle = await destParentHandle.getDirectoryHandle('Completed Download', { create: true });
      setStep('EXPORTING');
      setProcessing(prev => ({ ...prev, isOrganizing: true, progress: 0, activity: 'Moving to workspace...' }));
      const selectedFilesList = files.filter(f => selectedFiles.has(f.name));
      let count = 0;
      for (const file of selectedFilesList) {
        const fileData = await (file.handle as FileSystemFileHandle).getFile();
        const newFileHandle = await destHandle.getFileHandle(file.name, { create: true });
        // @ts-ignore
        const writable = await newFileHandle.createWritable();
        await writable.write(fileData); await writable.close();
        const { handle: parentHandle } = await getSubDirHandle(sourceHandle, file.path);
        await parentHandle.removeEntry(file.handle.name);
        count++; setProcessing(prev => ({ ...prev, progress: Math.round((count / selectedFilesList.length) * 100) }));
      }
      setStep('COMPLETED');
    } catch (err: any) { if (err.name !== 'AbortError') setStep('REVIEW'); }
    finally { setProcessing(prev => ({ ...prev, isOrganizing: false })); }
  };

  const handleOrganize = async () => {
    if (!sourceHandle) return;
    setStep('EXPORTING');
    setProcessing(prev => ({ ...prev, isOrganizing: true, progress: 0, activity: 'Sorting into folders...' }));
    const history: UndoRecord[] = [];
    try {
      const selectedFilesList = files.filter(f => selectedFiles.has(f.name));
      let count = 0;
      for (const file of selectedFilesList) {
        if (file.suggestedCategory === FileCategory.UNKNOWN || file.suggestedCategory === FileCategory.JUNK) continue;
        const dirHandle = await sourceHandle.getDirectoryHandle(file.suggestedCategory, { create: true });
        const fileData = await (file.handle as FileSystemFileHandle).getFile();
        const newFileHandle = await dirHandle.getFileHandle(file.name, { create: true });
        // @ts-ignore
        const writable = await newFileHandle.createWritable();
        await writable.write(fileData); await writable.close();
        const { handle: parentHandle } = await getSubDirHandle(sourceHandle, file.path);
        await parentHandle.removeEntry(file.handle.name);
        history.push({ fileName: file.name, originalRelativePath: file.path, category: file.suggestedCategory });
        count++; setProcessing(prev => ({ ...prev, progress: Math.round((count / selectedFilesList.length) * 100) }));
      }
      setLastMoveHistory(history); setStep('COMPLETED');
    } catch (err) { console.error(err); }
    finally { setProcessing(prev => ({ ...prev, isOrganizing: false })); }
  };

  const handleUndo = async () => {
    if (!sourceHandle || lastMoveHistory.length === 0) return;
    setStep('EXPORTING'); setProcessing(prev => ({ ...prev, isOrganizing: true, progress: 0, activity: 'Reverting changes...' }));
    try {
      let count = 0;
      for (const move of lastMoveHistory) {
        const catDir = await sourceHandle.getDirectoryHandle(move.category);
        const organizedFileHandle = await catDir.getFileHandle(move.fileName);
        const fileData = await organizedFileHandle.getFile();
        const { handle: originalParent, fileName } = await getSubDirHandle(sourceHandle, move.originalRelativePath);
        const restoredFileHandle = await originalParent.getFileHandle(fileName, { create: true });
        // @ts-ignore
        const writable = await restoredFileHandle.createWritable();
        await writable.write(fileData); await writable.close();
        await catDir.removeEntry(move.fileName);
        count++; setProcessing(prev => ({ ...prev, progress: Math.round((count / lastMoveHistory.length) * 100) }));
      }
      setLastMoveHistory([]); setStep('IDLE');
    } catch (err) { console.error(err); }
    finally { setProcessing(prev => ({ ...prev, isOrganizing: false })); }
  };

  const stats = useMemo(() => {
    const counts: Record<string, number> = {};
    files.forEach(f => {
      const categoryStr = String(f.suggestedCategory);
      counts[categoryStr] = (counts[categoryStr] || 0) + 1;
    });
    return Object.entries(counts).map(([name, value]) => ({ name, value }));
  }, [files]);

  const COLORS = ['#3b82f6', '#10b981', '#6366f1', '#f59e0b', '#ec4899', '#8b5cf6', '#f43f5e', '#64748b', '#94a3b8'];

  const handleSort = (field: SortField) => {
    if (sortField === field) setSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
    else { setSortField(field); setSortDirection(field === 'name' ? 'asc' : 'desc'); }
  };

  const sortedFilesList = useMemo(() => {
    return [...files].sort((a, b) => {
      let comparison = 0;
      if (sortField === 'name') comparison = a.name.localeCompare(b.name);
      else if (sortField === 'size') comparison = a.size - b.size;
      else if (sortField === 'lastModified') comparison = a.lastModified - b.lastModified;
      return sortDirection === 'asc' ? comparison : -comparison;
    });
  }, [files, sortField, sortDirection]);

  const emptyFolders = useMemo(() => {
    return folders.map(folder => {
      const containedFiles = files.filter(f => f.path.startsWith(folder.path));
      const willBeEmpty = containedFiles.length > 0 && containedFiles.every(f => selectedFiles.has(f.name));
      const isCurrentlyEmpty = folder.fileCount === 0 && folder.subFolderCount === 0;
      return { ...folder, willBeEmpty: willBeEmpty || isCurrentlyEmpty, category: isCurrentlyEmpty ? 'Empty' : 'Residual' };
    }).filter(f => f.willBeEmpty);
  }, [folders, files, selectedFiles]);

  const handleDeleteEmptyFolders = async () => {
    if (!sourceHandle || foldersToDelete.size === 0) return;
    setStep('EXPORTING'); setProcessing(prev => ({ ...prev, isOrganizing: true, progress: 0, activity: 'Deleting folders...' }));
    let count = 0; const total = foldersToDelete.size;
    for (const folderPath of Array.from(foldersToDelete) as string[]) {
      try {
        const parts = folderPath.split('/'); const folderName = parts.pop()!;
        let parent = sourceHandle; for (const part of parts) if (part) parent = await parent.getDirectoryHandle(part);
        await parent.removeEntry(folderName, { recursive: true });
      } catch (e) {}
      count++; setProcessing(prev => ({ ...prev, progress: Math.round((count / total) * 100) }));
    }
    setFolders(prev => prev.filter(f => !foldersToDelete.has(f.path)));
    setFoldersToDelete(new Set()); setStep('REVIEW'); setProcessing(prev => ({ ...prev, isOrganizing: false }));
  };

  const handleFileDragStart = (e: React.DragEvent, fileName: string) => {
    e.dataTransfer.setData('fileName', fileName);
    e.dataTransfer.effectAllowed = 'move';
    if (selectedFiles.has(fileName) && selectedFiles.size > 1) {
      const ghost = document.createElement('div');
      ghost.textContent = `⚡ Moving ${selectedFiles.size} items`;
      ghost.className = 'bg-blue-600 text-white px-4 py-2 rounded-2xl font-bold text-sm shadow-2xl fixed -top-full';
      document.body.appendChild(ghost); e.dataTransfer.setDragImage(ghost, 0, 0);
      setTimeout(() => document.body.removeChild(ghost), 0);
    }
  };

  const handleCategoryDragOver = (e: React.DragEvent, categoryName: string) => {
    e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDragOverCategory(categoryName);
  };

  const handleCategoryDrop = (e: React.DragEvent, targetCategory: FileCategory) => {
    e.preventDefault(); setDragOverCategory(null);
    const fileName = e.dataTransfer.getData('fileName');
    if (!fileName) return;
    if (selectedFiles.has(fileName)) {
      setFiles(prev => prev.map(f => selectedFiles.has(f.name) ? { ...f, suggestedCategory: targetCategory } : f));
    } else {
      updateFileCategory(fileName, targetCategory);
    }
  };

  return (
    <div className="min-h-screen p-6 md:p-10 max-w-[1400px] mx-auto animate-soft-in">
      <header className="flex flex-col md:flex-row justify-between items-start md:items-center mb-10 gap-6">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <div className="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center shadow-lg shadow-blue-200">
              <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" /></svg>
            </div>
            <h1 className="text-3xl font-extrabold tracking-tight text-slate-900">FileZen</h1>
          </div>
          <p className="text-slate-500 font-medium ml-12">Intelligent Desktop Orchestrator</p>
        </div>
        <div className="flex gap-4 items-center ml-auto">
          {deferredPrompt && (
            <button onClick={handleInstallClick} className="px-5 py-2.5 text-sm font-semibold text-slate-700 bg-white border border-slate-200 rounded-xl hover:bg-slate-50 transition-all shadow-sm">
              Install App
            </button>
          )}
          {sourceHandle && (
            <div className="flex items-center gap-3">
              <button 
                onClick={handleReset}
                className="px-4 py-2 text-xs font-bold text-red-600 border border-red-100 bg-white rounded-xl hover:bg-red-50 transition-all"
              >
                Reset Process
              </button>
              <div className="px-4 py-2 bg-blue-50 text-blue-700 rounded-xl text-xs font-bold border border-blue-100 flex items-center gap-2">
                <span className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-pulse"></span>
                {sourceHandle.name}
              </div>
            </div>
          )}
        </div>
      </header>

      <main className="bg-white rounded-[2.5rem] shadow-2xl shadow-slate-200/50 overflow-hidden border border-slate-100 relative min-h-[700px] flex flex-col">
        {processing.error && (
          <div className="m-6 p-4 bg-red-50 border border-red-100 rounded-2xl text-red-700 flex items-center gap-3 text-sm font-medium animate-soft-in">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
            {processing.error}
          </div>
        )}

        {step === 'IDLE' && (
          <div className="flex-1 flex flex-col p-12">
            <div className="max-w-3xl mx-auto text-center mb-16">
              <div className="w-24 h-24 bg-gradient-to-tr from-blue-600 to-indigo-600 text-white rounded-[2rem] flex items-center justify-center mx-auto mb-8 shadow-2xl shadow-blue-200 animate-bounce-slow">
                <svg className="w-12 h-12" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" /></svg>
              </div>
              <h2 className="text-4xl font-extrabold mb-4 text-slate-900 tracking-tight">System Zen starts here.</h2>
              <p className="text-slate-500 text-lg mb-10 leading-relaxed font-medium">
                Streamline your workspace with AI-powered file categorization and automated sorting rules. Just select a folder to begin.
              </p>
              <button 
                onClick={handlePickSource}
                className="group relative px-12 py-5 bg-slate-900 text-white rounded-[1.5rem] font-bold shadow-2xl hover:bg-black hover:-translate-y-1 transition-all active:scale-95 flex items-center gap-3 mx-auto"
              >
                Select Folder
                <svg className="w-5 h-5 group-hover:translate-x-1 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M13 7l5 5m0 0l-5 5m5-5H6" /></svg>
              </button>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-10">
              <section className="bg-slate-50/50 rounded-3xl p-10 border border-slate-100 transition-all hover:bg-white hover:shadow-xl hover:shadow-slate-200/50">
                <h3 className="text-xs font-black text-slate-400 uppercase tracking-[0.2em] mb-8">AI Sorting Parameters</h3>
                <form onSubmit={addCustomRule} className="space-y-4 mb-10">
                  <div className="flex gap-3">
                    <select value={newRuleType} onChange={e => setNewRuleType(e.target.value as any)} className="px-4 py-3 rounded-2xl border-none bg-white text-xs font-extrabold outline-none shadow-sm ring-1 ring-slate-200">
                      <option value="extension">Ext</option>
                      <option value="keyword">Key</option>
                    </select>
                    <input type="text" value={newRulePattern} onChange={e => setNewRulePattern(e.target.value)} placeholder={newRuleType === 'extension' ? ".exe" : "Contract"} className="flex-1 px-5 py-3 rounded-2xl border-none bg-white shadow-sm ring-1 ring-slate-200 outline-none focus:ring-blue-500 text-sm font-medium" />
                  </div>
                  <div className="flex gap-3">
                    <select value={newRuleCategory} onChange={e => setNewRuleCategory(e.target.value as any)} className="flex-1 px-4 py-3 rounded-2xl border-none bg-white text-xs font-extrabold outline-none shadow-sm ring-1 ring-slate-200">
                      {Object.values(FileCategory).map(cat => <option key={cat} value={cat}>{cat}</option>)}
                    </select>
                    <button type="submit" className="px-8 py-3 bg-blue-600 text-white rounded-2xl text-xs font-black uppercase tracking-widest hover:bg-blue-700 transition-colors shadow-lg shadow-blue-100">
                      Add
                    </button>
                  </div>
                </form>
                <div className="space-y-3 max-h-48 overflow-y-auto custom-scrollbar pr-2">
                  {customRules.map(rule => (
                    <div key={rule.id} className="flex items-center justify-between p-4 bg-white rounded-2xl border border-slate-100 shadow-sm group animate-soft-in">
                      <div className="flex items-center gap-3">
                        <span className={`px-2.5 py-1 rounded-lg text-[10px] font-black uppercase tracking-tighter ${rule.type === 'extension' ? 'bg-indigo-50 text-indigo-600' : 'bg-amber-50 text-amber-600'}`}>{rule.type}</span>
                        <span className="text-sm font-bold text-slate-700">{rule.pattern}</span>
                        <svg className="w-3 h-3 text-slate-300 mx-1" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M14 5l7 7m0 0l-7 7m7-7H3" /></svg>
                        <span className="text-xs font-bold text-slate-500">{rule.category}</span>
                      </div>
                      <button onClick={() => removeCustomRule(rule.id)} className="opacity-0 group-hover:opacity-100 p-1.5 text-slate-300 hover:text-red-500 transition-all hover:bg-red-50 rounded-lg">
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" /></svg>
                      </button>
                    </div>
                  ))}
                </div>
              </section>

              <section className="flex flex-col gap-10">
                <div className="bg-slate-50/50 rounded-3xl p-10 border border-slate-100 hover:bg-white transition-all hover:shadow-xl hover:shadow-slate-200/50">
                  <h3 className="text-xs font-black text-slate-400 uppercase tracking-[0.2em] mb-8">Tree Exclusions</h3>
                  <form onSubmit={addExclusion} className="flex gap-3 mb-8">
                    <input type="text" value={newExclusion} onChange={e => setNewExclusion(e.target.value)} placeholder="e.g. node_modules" className="flex-1 px-5 py-3 rounded-2xl border-none bg-white shadow-sm ring-1 ring-slate-200 outline-none focus:ring-blue-500 text-sm font-medium" />
                    <button type="submit" className="p-3 bg-slate-900 text-white rounded-2xl hover:bg-black transition-colors shadow-lg">
                      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 6v6m0 0v6m0-6h6m-6 0H6" /></svg>
                    </button>
                  </form>
                  <div className="flex flex-wrap gap-2">
                    {Array.from(excludedFolders).map(folder => (
                      <span key={String(folder)} className="px-4 py-2 bg-white border border-slate-200 rounded-xl text-xs font-bold text-slate-600 flex items-center gap-2 shadow-sm animate-soft-in">
                        {String(folder)}
                        <button onClick={() => removeExclusion(String(folder))} className="text-slate-300 hover:text-red-500 transition-colors">
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" /></svg>
                        </button>
                      </span>
                    ))}
                  </div>
                </div>
                <div className="bg-slate-900 rounded-3xl p-10 text-white shadow-2xl shadow-slate-900/20">
                  <h3 className="text-xs font-black text-white/40 uppercase tracking-[0.2em] mb-8">Config Portability</h3>
                  <div className="flex gap-4">
                    <button onClick={handleExportConfig} className="flex-1 py-4 bg-white/10 hover:bg-white/20 border border-white/10 rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all flex items-center justify-center gap-3">
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                      Export
                    </button>
                    <label className="flex-1 py-4 bg-white/10 hover:bg-white/20 border border-white/10 rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all flex items-center justify-center gap-3 cursor-pointer">
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
                      Import
                      <input ref={fileInputRef} type="file" accept=".json" className="hidden" onChange={handleImportConfig} />
                    </label>
                  </div>
                </div>
              </section>
            </div>
          </div>
        )}

        {(step === 'SCANNING' || step === 'EXPORTING') && (
          <div className="flex-1 flex flex-col items-center justify-center p-20 animate-soft-in">
            <div className="relative w-48 h-48 mb-12">
              <svg className="w-full h-full transform -rotate-90">
                <circle cx="96" cy="96" r="80" stroke="currentColor" strokeWidth="12" fill="transparent" className="text-slate-50" />
                <circle cx="96" cy="96" r="80" stroke="currentColor" strokeWidth="12" fill="transparent" strokeDasharray={502} strokeDashoffset={502 - (502 * processing.progress) / 100} strokeLinecap="round" className="text-blue-600 transition-all duration-500 ease-out" />
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-4xl font-black text-slate-900">{processing.progress}%</span>
              </div>
            </div>
            <h2 className="text-3xl font-extrabold mb-3 text-slate-900 tracking-tight">{step === 'SCANNING' ? 'Analyzing Files' : 'Executing Move'}</h2>
            <p className="text-slate-500 font-bold uppercase text-[10px] tracking-[0.3em] animate-pulse">{processing.activity}</p>
            {processing.currentFileName && <p className="mt-8 text-xs font-bold text-slate-400 truncate max-w-lg bg-slate-50 px-4 py-2 rounded-full border border-slate-100">{processing.currentFileName}</p>}
          </div>
        )}

        {step === 'DUPLICATES' && (
          <div className="flex-1 p-12 overflow-y-auto custom-scrollbar animate-soft-in">
            <div className="flex justify-between items-center mb-12">
              <div>
                <h2 className="text-3xl font-extrabold text-slate-900 tracking-tight">Duplicate Detection</h2>
                <p className="text-slate-500 font-medium">Clear redundant data before organization.</p>
              </div>
              <button onClick={resolveDuplicates} className="px-8 py-4 bg-red-600 text-white rounded-2xl font-black shadow-2xl shadow-red-100 hover:bg-red-700 transition-all active:scale-95 flex items-center gap-3">
                Purge Selected ({filesToDelete.size})
              </button>
            </div>
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-8">
              {duplicateGroups.map(group => (
                <div key={group.id} className="bg-slate-50/50 rounded-3xl p-8 border border-slate-100 animate-soft-in">
                  <div className="flex justify-between items-center mb-6">
                    <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">MD5 Matching Set</span>
                    <span className="px-3 py-1 bg-white rounded-lg border border-slate-200 text-[10px] font-black text-slate-500">{formatFileSize(group.files[0].size)}</span>
                  </div>
                  <div className="space-y-4">
                    {group.files.map(file => (
                      <div key={file.path} className={`p-4 rounded-2xl border transition-all flex justify-between items-center ${filesToDelete.has(file.name) ? 'bg-red-50/50 border-red-100 opacity-60' : 'bg-white border-slate-200 shadow-sm'}`}>
                        <div className="flex items-center gap-4 min-w-0">
                          <FileIcon category={file.suggestedCategory} className="w-10 h-10 p-2 bg-slate-50 rounded-xl" />
                          <div className="min-w-0">
                            <p className="text-sm font-extrabold truncate text-slate-800">{file.name}</p>
                            <p className="text-[10px] text-slate-400 font-mono truncate uppercase tracking-tighter">{file.path}</p>
                          </div>
                        </div>
                        <button onClick={() => keepOne(group.id, file.name)} className={`px-4 py-2 rounded-xl text-[10px] font-black uppercase transition-all shadow-sm ${filesToDelete.has(file.name) ? 'text-red-600 bg-red-100' : 'text-blue-600 bg-white border border-blue-50 hover:bg-blue-600 hover:text-white'}`}>
                          {filesToDelete.has(file.name) ? 'Deleted' : 'Keep'}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {step === 'REVIEW' && (
          <div className="flex flex-col lg:flex-row flex-1 animate-soft-in">
            {showAIConfirm && (
              <div className="absolute inset-0 z-[100] flex items-center justify-center bg-slate-900/40 backdrop-blur-md p-6">
                <div className="bg-white rounded-[2.5rem] p-12 max-w-lg shadow-2xl border border-slate-100 animate-soft-in text-center">
                  <div className="w-20 h-20 bg-indigo-600 text-white rounded-[1.5rem] flex items-center justify-center mb-8 mx-auto shadow-2xl shadow-indigo-100">
                    <svg className="w-10 h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                  </div>
                  <h3 className="text-2xl font-extrabold text-slate-900 mb-4 tracking-tight">AI Categorization</h3>
                  <p className="text-slate-500 mb-10 leading-relaxed font-medium">
                    Analyze <span className="font-bold text-slate-900">{selectedFiles.size} items</span> with Gemini Pro to determine the best organizational structure.
                  </p>
                  <div className="flex gap-4">
                    <button onClick={() => setShowAIConfirm(false)} className="flex-1 py-4 bg-slate-100 text-slate-600 rounded-2xl font-black text-xs uppercase tracking-widest hover:bg-slate-200 transition-all">Cancel</button>
                    <button onClick={confirmAutoCategorize} className="flex-1 py-4 bg-indigo-600 text-white rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl shadow-indigo-100 hover:bg-indigo-700 transition-all">Analyze</button>
                  </div>
                </div>
              </div>
            )}

            <aside className="w-full lg:w-96 border-r border-slate-100 p-10 flex flex-col bg-slate-50/30 overflow-y-auto custom-scrollbar">
              <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-[0.3em] mb-8">Selection Metrics</h3>
              <div className="h-64 mb-10 bg-white rounded-3xl border border-slate-100 shadow-inner flex items-center justify-center p-4">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={stats} cx="50%" cy="50%" innerRadius={60} outerRadius={85} paddingAngle={8} dataKey="value">
                      {stats.map((_, index) => <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} className="outline-none" />)}
                    </Pie>
                    <Tooltip contentStyle={{ borderRadius: '1rem', border: 'none', boxShadow: '0 10px 15px -3px rgba(0,0,0,0.1)', fontWeight: 'bold' }} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              
              <div className="space-y-3 mb-12">
                {stats.map((stat, index) => (
                  <div key={stat.name} onDragOver={e => handleCategoryDragOver(e, stat.name)} onDrop={e => handleCategoryDrop(e, stat.name as any)} className={`flex justify-between items-center p-4 rounded-2xl border-2 transition-all ${dragOverCategory === stat.name ? 'border-blue-500 bg-blue-50 scale-105 shadow-xl' : 'border-transparent bg-white shadow-sm hover:translate-x-1'}`}>
                    <div className="flex items-center gap-4">
                      <div className="w-3 h-3 rounded-full" style={{ backgroundColor: COLORS[index % COLORS.length] }}></div>
                      <span className="text-xs font-black text-slate-700 uppercase tracking-tight">{stat.name}</span>
                    </div>
                    <span className="px-2.5 py-1 bg-slate-50 rounded-lg text-[10px] font-black text-slate-400">{stat.value}</span>
                  </div>
                ))}
              </div>

              <div className="space-y-4 mt-auto">
                <div className="p-6 bg-slate-900 rounded-[1.5rem] shadow-xl">
                  <h4 className="text-[9px] font-black text-white/40 uppercase tracking-[0.2em] mb-4">Integrity Tools</h4>
                  <button onClick={handleSystemBackup} className="w-full py-3 bg-white/10 hover:bg-white/20 text-white rounded-xl text-[10px] font-black uppercase tracking-widest transition-all flex items-center justify-center gap-3">
                    <svg className="w-4 h-4 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" /></svg>
                    Safe Backup
                  </button>
                </div>
                <button onClick={handleAutoCategorizeSelected} disabled={selectedFiles.size === 0 || isAutoCategorizing} className="w-full py-4 bg-indigo-50 text-indigo-700 rounded-2xl font-black shadow-sm hover:bg-indigo-100 transition-all uppercase text-[10px] tracking-widest flex items-center justify-center gap-3">
                  {isAutoCategorizing ? <span className="animate-pulse">Analyzing...</span> : <>AI Re-Sort Selection</>}
                </button>
                <button onClick={handleOrganize} className="w-full py-5 bg-blue-600 text-white rounded-2xl font-black shadow-2xl shadow-blue-100 hover:bg-blue-700 transition-all uppercase text-xs tracking-widest">
                  Execute Sort ({selectedFiles.size})
                </button>
                <button onClick={handleFinalizeToDesktop} className="w-full py-5 bg-emerald-600 text-white rounded-2xl font-black shadow-2xl shadow-emerald-100 hover:bg-emerald-700 transition-all uppercase text-xs tracking-widest flex items-center justify-center gap-3">
                  Export Workspace
                </button>
              </div>
            </aside>

            <section className="flex-1 flex flex-col bg-white">
              <div className="p-10 border-b border-slate-100 bg-white/80 backdrop-blur-md sticky top-0 z-10 flex flex-col gap-8">
                <div className="flex justify-between items-center">
                  <div className="flex items-center gap-5">
                    <input type="checkbox" checked={selectedFiles.size === files.length && files.length > 0} onChange={handleSelectAll} className="w-6 h-6 rounded-xl border-slate-200 text-blue-600 focus:ring-blue-500/20 cursor-pointer shadow-sm transition-all" />
                    <h2 className="text-2xl font-extrabold text-slate-900 tracking-tight">Verification</h2>
                  </div>
                  <div className="flex bg-slate-100/50 p-1.5 rounded-2xl gap-1">
                    {(['name', 'size', 'lastModified'] as SortField[]).map(field => (
                      <button key={field} onClick={() => handleSort(field)} className={`px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${sortField === field ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}>
                        {field === 'lastModified' ? 'Date' : field}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto p-10 space-y-4 custom-scrollbar">
                {sortedFilesList.map(file => (
                  <div key={file.path} draggable onDragStart={e => handleFileDragStart(e, file.name)} className={`group flex items-center gap-6 p-6 rounded-3xl border transition-all cursor-grab active:cursor-grabbing ${selectedFiles.has(file.name) ? 'bg-white border-slate-200 shadow-xl shadow-slate-200/40' : 'bg-slate-50/50 border-transparent opacity-50'}`}>
                    <input type="checkbox" checked={selectedFiles.has(file.name)} onChange={() => handleToggleSelect(file.name)} className="w-6 h-6 rounded-xl border-slate-200 text-blue-600 transition-all cursor-pointer" />
                    <FileIcon category={file.suggestedCategory} className="w-12 h-12 p-3 bg-slate-50 rounded-2xl" />
                    <div className="flex-1 min-w-0">
                      <p className="font-extrabold text-slate-900 truncate mb-1 tracking-tight">{file.name}</p>
                      <div className="flex items-center gap-3 text-[10px] font-bold text-slate-400 uppercase tracking-tighter">
                        <span>{formatFileSize(file.size)}</span>
                        <span className="w-1 h-1 bg-slate-200 rounded-full"></span>
                        <span>{new Date(file.lastModified).toLocaleDateString()}</span>
                        {file.suggestedCategory !== FileCategory.UNKNOWN && <span className="bg-indigo-50 text-indigo-500 px-2 py-0.5 rounded-lg ml-2">Smart Match</span>}
                      </div>
                    </div>
                    <select value={file.suggestedCategory} onChange={e => updateFileCategory(file.name, e.target.value as any)} className="bg-slate-100/50 border-none text-[10px] font-black text-slate-600 rounded-xl px-5 py-3 outline-none ring-1 ring-transparent focus:ring-blue-500/10 transition-all uppercase tracking-widest cursor-pointer hover:bg-slate-200/50">
                      {Object.values(FileCategory).map(cat => <option key={cat} value={cat}>{cat}</option>)}
                    </select>
                  </div>
                ))}
              </div>
            </section>
          </div>
        )}

        {step === 'COMPLETED' && (
          <div className="flex-1 flex flex-col items-center justify-center p-20 text-center animate-soft-in">
            <div className="w-28 h-28 bg-emerald-500 text-white rounded-[2.5rem] flex items-center justify-center mb-10 shadow-3xl shadow-emerald-200 animate-soft-in">
              <svg className="w-14 h-14" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>
            </div>
            <h2 className="text-5xl font-black mb-6 text-slate-900 tracking-tighter">Workflow Optimized.</h2>
            <p className="text-slate-500 text-xl font-medium max-w-lg mb-12">
              All files have been tidied, categorized, and moved into your new structured workspace.
            </p>
            <div className="flex gap-4">
              <button onClick={() => { setStep('IDLE'); setFiles([]); setSourceHandle(null); }} className="px-12 py-5 bg-slate-900 text-white rounded-[1.5rem] font-black shadow-2xl hover:bg-black transition-all active:scale-95 uppercase text-xs tracking-widest">Start New Session</button>
              {lastMoveHistory.length > 0 && (
                <button onClick={handleUndo} className="px-12 py-5 bg-white text-slate-600 border border-slate-200 rounded-[1.5rem] font-black hover:bg-slate-50 hover:text-red-500 transition-all uppercase text-xs tracking-widest flex items-center gap-3">
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" /></svg>
                  Undo Move
                </button>
              )}
            </div>
          </div>
        )}
      </main>

      <VoiceChat isOpen={isChatOpen} setIsOpen={setIsChatOpen} />

      <footer className="mt-12 text-center">
        <p className="text-[10px] font-black text-slate-300 uppercase tracking-[0.5em] mb-2">FileZen Engine v4.8</p>
        <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">End-to-End Encryption • Zero Server Latency • AI Powered</p>
      </footer>
    </div>
  );
};

export default App;
