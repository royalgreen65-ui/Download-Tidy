
import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { FileMetadata, FileCategory, ProcessingState } from './types';
import { categorizeFiles } from './geminiService';
import { FileIcon } from './components/FileIcon';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';

const App: React.FC = () => {
  const [directoryHandle, setDirectoryHandle] = useState<FileSystemDirectoryHandle | null>(null);
  const [files, setFiles] = useState<FileMetadata[]>([]);
  const [processing, setProcessing] = useState<ProcessingState>({
    isScanning: false,
    isOrganizing: false,
    error: null,
    progress: 0
  });

  const handlePickFolder = async () => {
    try {
      setProcessing(prev => ({ ...prev, isScanning: true, error: null }));
      // @ts-ignore - File System Access API
      const handle = await window.showDirectoryPicker({
        mode: 'readwrite'
      });
      setDirectoryHandle(handle);
      await scanDirectory(handle);
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        setProcessing(prev => ({ ...prev, error: "Access denied or feature unsupported.", isScanning: false }));
      } else {
        setProcessing(prev => ({ ...prev, isScanning: false }));
      }
    }
  };

  const scanDirectory = async (handle: FileSystemDirectoryHandle) => {
    const foundFiles: FileMetadata[] = [];
    try {
      // @ts-ignore
      for await (const entry of handle.values()) {
        if (entry.kind === 'file') {
          // Narrow type to FileSystemFileHandle to access getFile()
          const fileHandle = entry as FileSystemFileHandle;
          const file = await fileHandle.getFile();
          foundFiles.push({
            name: entry.name,
            kind: 'file',
            size: file.size,
            lastModified: file.lastModified,
            extension: entry.name.split('.').pop()?.toLowerCase() || '',
            suggestedCategory: FileCategory.UNKNOWN,
            handle: entry
          });
        }
      }

      setProcessing(prev => ({ ...prev, progress: 50 }));

      // Categorize with Gemini
      const fileNames = foundFiles.map(f => f.name);
      if (fileNames.length > 0) {
        const categories = await categorizeFiles(fileNames);
        const updatedFiles = foundFiles.map(f => ({
          ...f,
          suggestedCategory: categories[f.name] || FileCategory.UNKNOWN
        }));
        setFiles(updatedFiles);
      } else {
        setFiles([]);
      }

      setProcessing(prev => ({ ...prev, isScanning: false, progress: 100 }));
    } catch (err) {
      setProcessing(prev => ({ ...prev, error: "Failed to read files.", isScanning: false }));
    }
  };

  const handleManualCategorization = (fileName: string, category: FileCategory) => {
    setFiles(prev => prev.map(f => f.name === fileName ? { ...f, suggestedCategory: category } : f));
  };

  const organizeFiles = async () => {
    if (!directoryHandle) return;
    setProcessing(prev => ({ ...prev, isOrganizing: true, progress: 0 }));

    try {
      // Explicitly type categoriesToCreate to avoid 'unknown' index type error
      const categoriesToCreate: FileCategory[] = Array.from(new Set(files.map(f => f.suggestedCategory)));
      const categoryHandles: Record<string, FileSystemDirectoryHandle> = {};

      // 1. Create subfolders
      for (const cat of categoriesToCreate) {
        if (cat === FileCategory.UNKNOWN) continue;
        categoryHandles[cat as string] = await directoryHandle.getDirectoryHandle(cat as string, { create: true });
      }

      // 2. Move files (Copy and then delete since direct move is complex in web API)
      let count = 0;
      for (const file of files) {
        if (file.suggestedCategory === FileCategory.UNKNOWN) continue;
        
        const destFolder = categoryHandles[file.suggestedCategory];
        const fileHandle = file.handle as FileSystemFileHandle;
        const fileData = await fileHandle.getFile();
        
        // Copy to new location
        const newFileHandle = await destFolder.getFileHandle(file.name, { create: true });
        // @ts-ignore
        const writable = await newFileHandle.createWritable();
        await writable.write(fileData);
        await writable.close();

        // Delete from old location
        await directoryHandle.removeEntry(file.name);
        
        count++;
        setProcessing(prev => ({ ...prev, progress: Math.round((count / files.length) * 100) }));
      }

      setProcessing(prev => ({ ...prev, isOrganizing: false, progress: 100 }));
      alert(`Success! Successfully organized ${count} files.`);
      setFiles([]); // Clear list after organization
      setDirectoryHandle(null);
    } catch (err) {
      console.error(err);
      setProcessing(prev => ({ ...prev, error: "Organization interrupted.", isOrganizing: false }));
    }
  };

  const statsData = useMemo(() => {
    const counts: Record<string, number> = {};
    files.forEach(f => {
      counts[f.suggestedCategory] = (counts[f.suggestedCategory] || 0) + 1;
    });
    return Object.entries(counts).map(([name, value]) => ({ name, value }));
  }, [files]);

  const COLORS = ['#3B82F6', '#10B981', '#8B5CF6', '#F59E0B', '#6366F1', '#EC4899', '#64748B'];

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      {/* Header */}
      <header className="flex flex-col md:flex-row md:items-center justify-between gap-6 mb-12">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 bg-blue-600 rounded-xl flex items-center justify-center text-white shadow-lg shadow-blue-200">
            <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
            </svg>
          </div>
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-slate-900">Download Tidy</h1>
            <p className="text-slate-500">AI-powered file organization and cleanup.</p>
          </div>
        </div>

        {!directoryHandle ? (
          <button
            onClick={handlePickFolder}
            className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-3 rounded-lg font-semibold flex items-center gap-2 transition-all shadow-md shadow-blue-100 transform active:scale-95"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
            </svg>
            Select Downloads Folder
          </button>
        ) : (
          <div className="flex items-center gap-3">
             <button
              onClick={() => setDirectoryHandle(null)}
              className="px-4 py-2 text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={organizeFiles}
              disabled={files.length === 0 || processing.isOrganizing}
              className="bg-green-600 hover:bg-green-700 disabled:bg-slate-300 text-white px-6 py-3 rounded-lg font-semibold flex items-center gap-2 transition-all shadow-md shadow-green-100 transform active:scale-95"
            >
              {processing.isOrganizing ? (
                <>
                  <svg className="animate-spin h-5 w-5 text-white" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  Organizing...
                </>
              ) : (
                <>
                   <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  Execute Cleanup
                </>
              )}
            </button>
          </div>
        )}
      </header>

      {/* Main Content */}
      <main>
        {processing.error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl mb-8 flex items-center gap-3">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            {processing.error}
          </div>
        )}

        {processing.isScanning && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="w-16 h-16 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mb-4"></div>
            <h2 className="text-xl font-semibold">Scanning Directory...</h2>
            <p className="text-slate-500">Gemini is analyzing your files and suggesting categories.</p>
          </div>
        )}

        {files.length > 0 && !processing.isScanning && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            {/* List Section */}
            <div className="lg:col-span-2 space-y-6">
              <div className="glass border border-white/50 rounded-2xl overflow-hidden shadow-sm">
                <div className="bg-white/50 px-6 py-4 border-b border-slate-100 flex justify-between items-center">
                  <h3 className="font-semibold text-slate-800">Files to Tidy ({files.length})</h3>
                  <span className="text-xs font-medium text-slate-500 bg-slate-100 px-2 py-1 rounded-full">Detected</span>
                </div>
                <div className="divide-y divide-slate-100 max-h-[600px] overflow-y-auto">
                  {files.map((file) => (
                    <div key={file.name} className="px-6 py-4 hover:bg-slate-50/50 flex items-center justify-between group">
                      <div className="flex items-center gap-3 overflow-hidden">
                        <FileIcon category={file.suggestedCategory} className="w-6 h-6 flex-shrink-0" />
                        <div className="overflow-hidden">
                          <p className="font-medium text-slate-800 truncate" title={file.name}>{file.name}</p>
                          <p className="text-xs text-slate-400">{(file.size / 1024 / 1024).toFixed(2)} MB</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-4">
                        <select
                          value={file.suggestedCategory}
                          onChange={(e) => handleManualCategorization(file.name, e.target.value as FileCategory)}
                          className="text-sm bg-white border border-slate-200 rounded-md px-2 py-1 focus:ring-2 focus:ring-blue-500 outline-none"
                        >
                          {Object.values(FileCategory).map(cat => (
                            <option key={cat} value={cat}>{cat}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Sidebar Stats */}
            <div className="space-y-6">
              <div className="glass border border-white/50 rounded-2xl p-6 shadow-sm">
                <h3 className="font-semibold text-slate-800 mb-4">Organization Summary</h3>
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={statsData}
                        cx="50%"
                        cy="50%"
                        innerRadius={60}
                        outerRadius={80}
                        paddingAngle={5}
                        dataKey="value"
                      >
                        {statsData.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="mt-4 space-y-2">
                  {statsData.map((stat, idx) => (
                    <div key={stat.name} className="flex items-center justify-between text-sm">
                      <div className="flex items-center gap-2">
                        <div className="w-2 h-2 rounded-full" style={{ backgroundColor: COLORS[idx % COLORS.length] }}></div>
                        <span className="text-slate-600">{stat.name}</span>
                      </div>
                      <span className="font-semibold text-slate-800">{stat.value}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="bg-blue-600 rounded-2xl p-6 text-white shadow-lg shadow-blue-100">
                <h4 className="font-bold text-lg mb-2">Ready to clean?</h4>
                <p className="text-blue-100 text-sm mb-4">Files will be moved into categorized folders within your directory. This cannot be undone automatically.</p>
                <div className="flex items-center gap-2 text-sm text-blue-100 bg-blue-700/50 p-3 rounded-lg">
                  <svg className="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  Final step: Move "Completed" files to your Desktop.
                </div>
              </div>
            </div>
          </div>
        )}

        {!directoryHandle && !processing.isScanning && (
          <div className="bg-white border-2 border-dashed border-slate-200 rounded-3xl p-12 text-center max-w-2xl mx-auto mt-12">
            <div className="w-20 h-20 bg-blue-50 text-blue-600 rounded-2xl flex items-center justify-center mx-auto mb-6">
              <svg className="w-10 h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
              </svg>
            </div>
            <h2 className="text-2xl font-bold text-slate-900 mb-2">No Folder Selected</h2>
            <p className="text-slate-500 mb-8 px-4">Download Tidy needs access to your Downloads folder to scan and organize your files. We only process files locally in your browser.</p>
            <button
              onClick={handlePickFolder}
              className="bg-slate-900 hover:bg-slate-800 text-white px-8 py-3 rounded-xl font-semibold transition-all shadow-lg shadow-slate-200"
            >
              Get Started
            </button>
          </div>
        )}
      </main>

      {/* Progress Overlay */}
      {processing.isOrganizing && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-3xl p-8 max-w-md w-full shadow-2xl text-center">
            <h3 className="text-2xl font-bold mb-2">Cleaning Up...</h3>
            <p className="text-slate-500 mb-8">Please don't close this window until finished.</p>
            
            <div className="w-full bg-slate-100 rounded-full h-3 mb-4 overflow-hidden">
              <div 
                className="bg-blue-600 h-full transition-all duration-300 ease-out"
                style={{ width: `${processing.progress}%` }}
              ></div>
            </div>
            <div className="flex justify-between text-sm font-medium">
              <span className="text-blue-600">{processing.progress}% Complete</span>
              <span className="text-slate-400">{files.length} Files</span>
            </div>
          </div>
        </div>
      )}

      {/* Footer Info */}
      <footer className="mt-20 pt-8 border-t border-slate-200 text-center text-slate-400 text-sm">
        <p>&copy; 2024 Download Tidy. Built with Gemini 3 Pro.</p>
        <p className="mt-1">All processing happens in your browser. No files are uploaded to our servers.</p>
      </footer>
    </div>
  );
};

export default App;
