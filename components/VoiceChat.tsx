
import React, { useState, useEffect, useRef } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';

interface Message {
  role: 'user' | 'model';
  text: string;
}

interface VoiceChatProps {
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
}

export const VoiceChat: React.FC<VoiceChatProps> = ({ isOpen, setIsOpen }) => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [isLive, setIsLive] = useState(false);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [isTTSLoading, setIsTTSLoading] = useState<string | null>(null);
  
  const currentInputText = useRef('');
  const currentOutputText = useRef('');
  const [streamingUserText, setStreamingUserText] = useState('');
  const [streamingModelText, setStreamingModelText] = useState('');

  const sessionRef = useRef<any>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const nextStartTimeRef = useRef<number>(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationFrameRef = useRef<number>(0);
  const analyzerRef = useRef<AnalyserNode | null>(null);

  const decodeBase64 = (base64: string) => {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
    return bytes;
  };

  const encodeBase64 = (bytes: Uint8Array) => {
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  };

  const decodeAudioData = async (data: Uint8Array, ctx: AudioContext, sampleRate: number, numChannels: number): Promise<AudioBuffer> => {
    const dataInt16 = new Int16Array(data.buffer);
    const frameCount = dataInt16.length / numChannels;
    const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);
    for (let channel = 0; channel < numChannels; channel++) {
      const channelData = buffer.getChannelData(channel);
      for (let i = 0; i < frameCount; i++) channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
    return buffer;
  };

  const createPCM16Blob = (data: Float32Array) => {
    const l = data.length;
    const int16 = new Int16Array(l);
    for (let i = 0; i < l; i++) int16[i] = Math.max(-1, Math.min(1, data[i])) * 32768;
    return { data: encodeBase64(new Uint8Array(int16.buffer)), mimeType: 'audio/pcm;rate=16000' };
  };

  const stopAllPlayback = () => {
    sourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
    sourcesRef.current.clear(); nextStartTimeRef.current = 0;
  };

  const drawVisualizer = () => {
    if (!canvasRef.current || !analyzerRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const bufferLength = analyzerRef.current.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    const render = () => {
      animationFrameRef.current = requestAnimationFrame(render);
      analyzerRef.current!.getByteFrequencyData(dataArray);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const barWidth = (canvas.width / bufferLength) * 3;
      let x = 0;
      for (let i = 0; i < bufferLength; i++) {
        const barHeight = (dataArray[i] / 255) * canvas.height;
        ctx.fillStyle = `rgba(37, 99, 235, ${dataArray[i] / 255 + 0.2})`;
        ctx.fillRect(x, (canvas.height - barHeight) / 2, barWidth - 2, barHeight);
        x += barWidth;
      }
    };
    render();
  };

  const handleSpeakMessage = async (text: string, messageId: string) => {
    if (isTTSLoading) return;
    setIsTTSLoading(messageId);
    try {
      if (!outputAudioContextRef.current) {
        outputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
        const gain = outputAudioContextRef.current.createGain();
        gain.connect(outputAudioContextRef.current.destination);
        gainNodeRef.current = gain;
      }
      if (outputAudioContextRef.current.state === 'suspended') await outputAudioContextRef.current.resume();
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash-preview-tts",
        contents: [{ parts: [{ text: `Read: ${text}` }] }],
        config: { responseModalities: [Modality.AUDIO], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } } }
      });
      const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (base64Audio) {
        stopAllPlayback();
        const audioBuffer = await decodeAudioData(decodeBase64(base64Audio), outputAudioContextRef.current, 24000, 1);
        const sourceNode = outputAudioContextRef.current.createBufferSource();
        sourceNode.buffer = audioBuffer; sourceNode.connect(gainNodeRef.current!);
        sourceNode.start(); sourcesRef.current.add(sourceNode);
        sourceNode.onended = () => sourcesRef.current.delete(sourceNode);
      }
    } catch (err) { console.error(err); }
    finally { setIsTTSLoading(null); }
  };

  const startLiveSession = async () => {
    if (isLive) { stopLiveSession(); return; }
    try {
      if (!audioContextRef.current) audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      if (!outputAudioContextRef.current) {
        const ctx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
        const gain = ctx.createGain(); gain.connect(ctx.destination);
        outputAudioContextRef.current = ctx; gainNodeRef.current = gain;
      }
      if (audioContextRef.current.state === 'suspended') await audioContextRef.current.resume();
      if (outputAudioContextRef.current.state === 'suspended') await outputAudioContextRef.current.resume();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      setIsLive(true);
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        callbacks: {
          onopen: () => {
            const source = audioContextRef.current!.createMediaStreamSource(stream);
            const analyzer = audioContextRef.current!.createAnalyser();
            analyzer.fftSize = 64; analyzerRef.current = analyzer;
            source.connect(analyzer);
            const processor = audioContextRef.current!.createScriptProcessor(4096, 1, 1);
            processor.onaudioprocess = (e) => {
              const blob = createPCM16Blob(e.inputBuffer.getChannelData(0));
              sessionPromise.then(s => s.sendRealtimeInput({ media: blob }));
            };
            source.connect(processor); processor.connect(audioContextRef.current!.destination);
            drawVisualizer();
            (sessionRef.current as any).cleanup = () => {
              stream.getTracks().forEach(t => t.stop());
              processor.disconnect(); source.disconnect();
              cancelAnimationFrame(animationFrameRef.current); stopAllPlayback();
            };
          },
          onmessage: async (msg: LiveServerMessage) => {
            if (msg.serverContent?.inputTranscription) { currentInputText.current += msg.serverContent.inputTranscription.text; setStreamingUserText(currentInputText.current); }
            if (msg.serverContent?.outputTranscription) { currentOutputText.current += msg.serverContent.outputTranscription.text; setStreamingModelText(currentOutputText.current); }
            if (msg.serverContent?.turnComplete) {
              const u = currentInputText.current.trim(); const m = currentOutputText.current.trim();
              if (u || m) setMessages(prev => [...prev, ...(u ? [{role:'user', text:u}] : []), ...(m ? [{role:'model', text:m}] : []) as Message[]]);
              currentInputText.current = ''; currentOutputText.current = ''; setStreamingUserText(''); setStreamingModelText('');
            }
            const audioData = msg.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (audioData && outputAudioContextRef.current && gainNodeRef.current) {
              const buffer = await decodeAudioData(decodeBase64(audioData), outputAudioContextRef.current, 24000, 1);
              const sourceNode = outputAudioContextRef.current.createBufferSource();
              sourceNode.buffer = buffer; sourceNode.connect(gainNodeRef.current);
              const now = outputAudioContextRef.current.currentTime; nextStartTimeRef.current = Math.max(nextStartTimeRef.current, now);
              sourceNode.start(nextStartTimeRef.current); nextStartTimeRef.current += buffer.duration;
              sourcesRef.current.add(sourceNode); sourceNode.onended = () => sourcesRef.current.delete(sourceNode);
            }
            if (msg.serverContent?.interrupted) stopAllPlayback();
          },
          onerror: (err) => { console.error(err); setIsLive(false); },
          onclose: () => { setIsLive(false); if (sessionRef.current?.cleanup) sessionRef.current.cleanup(); },
        },
        config: {
          responseModalities: [Modality.AUDIO], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } } },
          inputAudioTranscription: {}, outputAudioTranscription: {},
          systemInstruction: "You are FileZen Voice, helping with file organization questions."
        }
      });
      sessionRef.current = await sessionPromise;
    } catch (err) { console.error(err); setIsLive(false); }
  };

  const stopLiveSession = () => {
    if (sessionRef.current) {
      if (sessionRef.current.cleanup) sessionRef.current.cleanup();
      if (sessionRef.current.close) sessionRef.current.close();
      sessionRef.current = null;
    }
    setIsLive(false); setStreamingUserText(''); setStreamingModelText('');
    if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
  };

  const handleSendMessage = async () => {
    if (!inputText.trim()) return;
    const userMsg = inputText.trim(); setInputText('');
    setMessages(prev => [...prev, { role: 'user', text: userMsg }]);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview", contents: userMsg,
        config: { systemInstruction: "Answer concisely about file management." }
      });
      setMessages(prev => [...prev, { role: 'model', text: response.text || "I couldn't process that." }]);
    } catch (err) { console.error(err); }
  };

  useEffect(() => {
    if (gainNodeRef.current) gainNodeRef.current.gain.setValueAtTime(isMuted ? 0 : volume, outputAudioContextRef.current?.currentTime || 0);
  }, [volume, isMuted]);

  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [messages, streamingUserText, streamingModelText]);

  return (
    <>
      <button onClick={() => setIsOpen(!isOpen)} className={`fixed bottom-8 right-8 w-16 h-16 rounded-[1.5rem] shadow-2xl flex items-center justify-center transition-all z-50 hover:scale-110 active:scale-95 ${isOpen ? 'bg-slate-900' : 'bg-blue-600'} text-white`}>
        {isOpen ? <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M19 9l-7 7-7-7" /></svg> : <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" /></svg>}
      </button>

      <div className={`fixed bottom-28 right-8 w-80 md:w-96 bg-white/95 backdrop-blur-2xl border border-slate-200 rounded-[2.5rem] shadow-[0_32px_64px_-16px_rgba(0,0,0,0.1)] transition-all z-50 overflow-hidden flex flex-col ${isOpen ? 'translate-y-0 opacity-100' : 'translate-y-12 opacity-0 pointer-events-none'}`}>
        <div className="p-6 bg-slate-900 text-white flex justify-between items-center">
          <div className="flex items-center gap-3">
            <div className={`w-2.5 h-2.5 rounded-full ${isLive ? 'bg-emerald-500 animate-pulse' : 'bg-slate-600'}`}></div>
            <span className="font-extrabold text-sm tracking-tight">Voice Orchestrator</span>
          </div>
          {isLive && <button onClick={stopAllPlayback} className="px-3 py-1 bg-white/10 hover:bg-white/20 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all">Interrupt</button>}
        </div>

        <div className="bg-slate-50 border-b border-slate-100 px-6 py-4 flex items-center justify-center">
           <canvas ref={canvasRef} width="200" height="40" className={`w-full max-w-[200px] h-10 transition-opacity duration-300 ${isLive ? 'opacity-100' : 'opacity-0.2'}`} />
        </div>

        <div ref={scrollRef} className="flex-1 p-6 space-y-6 overflow-y-auto max-h-[400px] min-h-[350px] custom-scrollbar bg-white/50">
          {messages.length === 0 && !streamingUserText && !streamingModelText && (
            <div className="text-center py-12 opacity-30 animate-soft-in">
              <div className="w-14 h-14 bg-blue-100 text-blue-600 rounded-2xl flex items-center justify-center mx-auto mb-4">
                <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" /></svg>
              </div>
              <p className="text-[10px] font-black uppercase text-slate-400 tracking-[0.3em]">AI Voice Active</p>
            </div>
          )}

          {messages.map((m, i) => (
            <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'} animate-soft-in`}>
              <div className={`relative group max-w-[85%] px-5 py-3 rounded-2xl text-sm font-medium ${m.role === 'user' ? 'bg-blue-600 text-white shadow-lg' : 'bg-white text-slate-800 border border-slate-200 shadow-sm'}`}>
                {m.text}
                {m.role === 'model' && (
                  <button onClick={() => handleSpeakMessage(m.text, `msg-${i}`)} className="absolute -right-12 top-1/2 -translate-y-1/2 p-2 bg-white rounded-xl shadow-md border border-slate-100 text-slate-400 hover:text-blue-600 opacity-0 group-hover:opacity-100 transition-all focus:opacity-100">
                    {isTTSLoading === `msg-${i}` ? <div className="w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin"></div> : <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" /></svg>}
                  </button>
                )}
              </div>
            </div>
          ))}

          {streamingUserText && <div className="flex justify-end animate-pulse"><div className="max-w-[85%] px-5 py-3 rounded-2xl text-sm bg-blue-600/90 text-white italic shadow-inner">{streamingUserText}</div></div>}
          {streamingModelText && <div className="flex justify-start"><div className="max-w-[85%] px-5 py-3 rounded-2xl text-sm bg-white text-slate-800 border border-slate-200 shadow-sm">{streamingModelText}</div></div>}
        </div>

        <div className="p-6 bg-white border-t border-slate-100">
          <div className="flex gap-3">
            <button onClick={startLiveSession} className={`p-4 rounded-2xl transition-all shadow-lg ${isLive ? 'bg-red-500 text-white scale-105 shadow-red-100' : 'bg-slate-100 text-slate-600 hover:bg-slate-200 shadow-slate-100'}`}>
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" /></svg>
            </button>
            <div className="flex-1 relative">
              <input type="text" value={inputText} onChange={e => setInputText(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleSendMessage()} placeholder={isLive ? "Analyzing voice..." : "Type command..."} className="w-full bg-slate-100 border-none rounded-2xl px-5 py-4 text-sm font-semibold focus:ring-4 focus:ring-blue-500/10 outline-none transition-all placeholder:text-slate-400" />
              {!isLive && inputText.trim() && <button onClick={handleSendMessage} className="absolute right-3 top-1/2 -translate-y-1/2 p-2 bg-blue-600 text-white rounded-xl shadow-lg hover:bg-blue-700 transition-all"><svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg></button>}
            </div>
          </div>
          <div className="mt-4 flex items-center justify-between px-2">
            <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{isLive ? 'Connected' : 'Standby'}</span>
            <div className="flex items-center gap-2">
              <button onClick={() => setIsMuted(!isMuted)} className="text-slate-300 hover:text-slate-600">
                {isMuted ? <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" /></svg> : <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" /></svg>}
              </button>
              <input type="range" min="0" max="1" step="0.1" value={volume} onChange={e => setVolume(parseFloat(e.target.value))} className="w-12 h-1 bg-slate-100 rounded-full appearance-none cursor-pointer accent-blue-600" />
            </div>
          </div>
        </div>
      </div>
    </>
  );
};
