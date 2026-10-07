import React, { useState, useEffect, useMemo, useRef } from 'react';
import { MediaItem } from '@omnipost/core';
import { renderMarkdown, splitMarkdownIntoBlocks } from '../popup/markdown';
import { OmniPostLogo } from './OmniPostLogo';
import { t, Lang } from '../lib/i18n';

export interface PreviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  body: string;
  mediaList: MediaItem[];
  onSave: (newTitle: string, newBody: string, newMedia: MediaItem[]) => void;
  lang?: Lang;
}

export const PreviewModal: React.FC<PreviewModalProps> = ({
  isOpen,
  onClose,
  title,
  body,
  mediaList,
  onSave,
  lang = 'zh',
}) => {
  const _ = (key: string) => t(key, lang);

  const [currentTitle, setCurrentTitle] = useState(title);
  const [currentBody, setCurrentBody] = useState(body);
  const [currentMedia, setCurrentMedia] = useState<MediaItem[]>(mediaList);
  const [viewMode, setViewMode] = useState<'preview' | 'split'>('preview');
  const [autoInsertMarkdown, setAutoInsertMarkdown] = useState(true);

  // 对照润色双向同步滚动（段落级锚点精准分段对齐）
  const [syncScroll, setSyncScroll] = useState(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const previewPaneRef = useRef<HTMLDivElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const isSyncingLeftRef = useRef(false);
  const isSyncingRightRef = useRef(false);

  const blocks = useMemo(() => {
    return splitMarkdownIntoBlocks(currentBody);
  }, [currentBody]);

  // 将 currentBody 无损切分为与 blocks 一一对应的镜像文本块，用于精准测算左侧各段真实像素位置
  const blockChunks = useMemo(() => {
    if (blocks.length === 0) return [];
    let searchPos = 0;
    const indices: number[] = [];
    for (let i = 0; i < blocks.length; i++) {
      const idx = currentBody.indexOf(blocks[i], searchPos);
      const start = idx !== -1 ? idx : searchPos;
      indices.push(start);
      searchPos = start + blocks[i].length;
    }
    const chunks: string[] = [];
    for (let i = 0; i < blocks.length; i++) {
      const start = i === 0 ? 0 : indices[i];
      const end = i + 1 < blocks.length ? indices[i + 1] : currentBody.length;
      chunks.push(currentBody.slice(start, end));
    }
    return chunks;
  }, [currentBody, blocks]);

  // 提取左侧源码段落与右侧渲染段落的一对一像素锚点
  const getBlockAnchors = () => {
    const left = textareaRef.current;
    const right = previewPaneRef.current;
    const mirror = mirrorRef.current;
    if (!left || !right || !mirror) return null;

    // 动态同步镜像元素宽度与 textarea 客户区宽度
    if (mirror.style.width !== `${left.clientWidth}px`) {
      mirror.style.width = `${left.clientWidth}px`;
    }

    const maxLeft = Math.max(0, left.scrollHeight - left.clientHeight);
    const maxRight = Math.max(0, right.scrollHeight - right.clientHeight);
    if (maxLeft <= 0 || maxRight <= 0) return null;

    const leftEls = mirror.querySelectorAll<HTMLElement>('[data-mirror-idx]');
    const rightEls = right.querySelectorAll<HTMLElement>('[data-block-idx]');
    const count = Math.min(leftEls.length, rightEls.length);
    if (count === 0) return null;

    const leftOffsets: number[] = [];
    const rightOffsets: number[] = [];
    const rightContainerRect = right.getBoundingClientRect();

    for (let i = 0; i < count; i++) {
      if (i === 0) {
        // 首个段落顶部锚点置 0
        leftOffsets.push(0);
        rightOffsets.push(0);
      } else {
        const lTop = Math.max(0, leftEls[i].offsetTop - 16);
        leftOffsets.push(Math.max(leftOffsets[i - 1], lTop));

        const rRect = rightEls[i].getBoundingClientRect();
        const rTop = Math.max(0, rRect.top - rightContainerRect.top + right.scrollTop - 16);
        rightOffsets.push(Math.max(rightOffsets[i - 1], rTop));
      }
    }

    // 尾部锚点对齐滚动终点
    leftOffsets.push(maxLeft);
    rightOffsets.push(maxRight);

    return { leftOffsets, rightOffsets, maxLeft, maxRight };
  };

  // 分段线性插值计算
  const interpolateScroll = (
    pos: number,
    srcOffsets: number[],
    dstOffsets: number[],
    maxDst: number
  ): number => {
    if (srcOffsets.length === 0 || dstOffsets.length === 0) return 0;
    if (pos <= 0) return 0;
    const maxSrc = srcOffsets[srcOffsets.length - 1];
    if (pos >= maxSrc) return maxDst;

    for (let i = 0; i < srcOffsets.length - 1; i++) {
      const s0 = srcOffsets[i];
      const s1 = srcOffsets[i + 1];
      if (pos >= s0 && pos <= s1) {
        const segSpan = s1 - s0;
        const progress = segSpan > 0 ? (pos - s0) / segSpan : 0;
        const d0 = dstOffsets[i];
        const d1 = dstOffsets[i + 1];
        return Math.round(d0 + progress * (d1 - d0));
      }
    }
    return Math.min(maxDst, Math.max(0, Math.round((pos / maxSrc) * maxDst)));
  };

  const handleLeftScroll = () => {
    if (!syncScroll) return;
    if (isSyncingLeftRef.current) {
      isSyncingLeftRef.current = false;
      return;
    }
    const left = textareaRef.current;
    const right = previewPaneRef.current;
    if (!left || !right) return;

    const anchors = getBlockAnchors();
    if (!anchors) {
      const maxLeft = left.scrollHeight - left.clientHeight;
      const maxRight = right.scrollHeight - right.clientHeight;
      if (maxLeft <= 0 || maxRight <= 0) return;
      const ratio = Math.min(1, Math.max(0, left.scrollTop / maxLeft));
      isSyncingRightRef.current = true;
      right.scrollTop = Math.round(ratio * maxRight);
      return;
    }

    const targetRight = interpolateScroll(
      left.scrollTop,
      anchors.leftOffsets,
      anchors.rightOffsets,
      anchors.maxRight
    );
    isSyncingRightRef.current = true;
    right.scrollTop = targetRight;
  };

  const handleRightScroll = () => {
    if (!syncScroll) return;
    if (isSyncingRightRef.current) {
      isSyncingRightRef.current = false;
      return;
    }
    const left = textareaRef.current;
    const right = previewPaneRef.current;
    if (!left || !right) return;

    const anchors = getBlockAnchors();
    if (!anchors) {
      const maxLeft = left.scrollHeight - left.clientHeight;
      const maxRight = right.scrollHeight - right.clientHeight;
      if (maxLeft <= 0 || maxRight <= 0) return;
      const ratio = Math.min(1, Math.max(0, right.scrollTop / maxRight));
      isSyncingLeftRef.current = true;
      left.scrollTop = Math.round(ratio * maxLeft);
      return;
    }

    const targetLeft = interpolateScroll(
      right.scrollTop,
      anchors.rightOffsets,
      anchors.leftOffsets,
      anchors.maxLeft
    );
    isSyncingLeftRef.current = true;
    left.scrollTop = targetLeft;
  };

  // imageSlots: mediaId -> slot index (0 = cover, 1..N = after block i, N = end, -1 = unplaced tray)
  const [imageSlots, setImageSlots] = useState<Record<string, number>>({});
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [activeDropSlot, setActiveDropSlot] = useState<number | null>(null);

  // Inline block edit
  const [editingBlockIndex, setEditingBlockIndex] = useState<number | null>(null);
  const [editingBlockText, setEditingBlockText] = useState('');

  // Sync initial state when modal opens
  useEffect(() => {
    if (isOpen) {
      setCurrentTitle(title);
      setCurrentBody(body);
      setCurrentMedia(mediaList);
      setEditingBlockIndex(null);

      const parsedBlocks = splitMarkdownIntoBlocks(body);
      const initialSlots: Record<string, number> = {};
      const numBlocks = Math.max(1, parsedBlocks.length);

      mediaList.forEach((m, idx) => {
        if (body.includes(m.name) || (m.dataUrl && body.includes(m.dataUrl))) {
          // Already in markdown
          initialSlots[m.id] = -1;
        } else if (mediaList.length === 1) {
          initialSlots[m.id] = numBlocks > 1 ? 1 : 0;
        } else {
          const step = Math.max(1, Math.floor(numBlocks / mediaList.length));
          initialSlots[m.id] = Math.min(numBlocks, idx * step + (numBlocks > 1 ? 1 : 0));
        }
      });
      setImageSlots(initialSlots);
    }
  }, [isOpen, title, body, mediaList]);

  // Handle ESC key to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);


  const wordCount = useMemo(() => {
    const cn = (currentBody.match(/[一-龥]/g) || []).length;
    const en = (currentBody.replace(/[一-龥]/g, ' ').match(/[a-zA-Z0-9_-]+/g) || []).length;
    return cn + en;
  }, [currentBody]);

  const readingTime = useMemo(() => {
    return Math.max(1, Math.ceil(wordCount / 300));
  }, [wordCount]);

  if (!isOpen) return null;

  // Drag and Drop handlers
  const handleDragStart = (e: React.DragEvent, id: string) => {
    e.dataTransfer.setData('text/plain', id);
    e.dataTransfer.effectAllowed = 'move';
    setDraggingId(id);
  };

  const handleDragEnd = () => {
    setDraggingId(null);
    setActiveDropSlot(null);
  };

  const handleDragOver = (e: React.DragEvent, slot: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setActiveDropSlot(slot);
  };

  const handleDrop = (e: React.DragEvent, slot: number) => {
    e.preventDefault();
    const id = e.dataTransfer.getData('text/plain') || draggingId;
    if (id) {
      setImageSlots((prev) => ({ ...prev, [id]: slot }));
    }
    setDraggingId(null);
    setActiveDropSlot(null);
  };

  // Button move actions
  const moveImage = (id: string, delta: number) => {
    const current = imageSlots[id] ?? 0;
    const maxSlot = Math.max(1, blocks.length);
    const nextSlot = Math.max(0, Math.min(maxSlot, current + delta));
    setImageSlots((prev) => ({ ...prev, [id]: nextSlot }));
  };

  const moveToCover = (id: string) => {
    setImageSlots((prev) => ({ ...prev, [id]: 0 }));
  };

  const moveToEnd = (id: string) => {
    setImageSlots((prev) => ({ ...prev, [id]: Math.max(1, blocks.length) }));
  };

  const removeFromArticle = (id: string) => {
    setImageSlots((prev) => ({ ...prev, [id]: -1 }));
  };

  // Batch layout actions
  const distributeEvenly = () => {
    const maxSlot = Math.max(1, blocks.length);
    const updated: Record<string, number> = {};
    currentMedia.forEach((m, idx) => {
      const slot = Math.min(maxSlot, Math.floor(((idx + 1) * maxSlot) / (currentMedia.length + 1)) || 1);
      updated[m.id] = slot;
    });
    setImageSlots(updated);
  };

  const moveAllToEnd = () => {
    const maxSlot = Math.max(1, blocks.length);
    const updated: Record<string, number> = {};
    currentMedia.forEach((m) => {
      updated[m.id] = maxSlot;
    });
    setImageSlots(updated);
  };

  const removeAllFromArticle = () => {
    const updated: Record<string, number> = {};
    currentMedia.forEach((m) => {
      updated[m.id] = -1;
    });
    setImageSlots(updated);
  };

  // Inline block edit
  const startEditBlock = (index: number, text: string) => {
    setEditingBlockIndex(index);
    setEditingBlockText(text);
  };

  const saveBlockEdit = (index: number) => {
    const newBlocks = [...blocks];
    newBlocks[index] = editingBlockText;
    setCurrentBody(newBlocks.join('\n\n'));
    setEditingBlockIndex(null);
  };

  // Final Save & Apply
  const handleSave = () => {
    const sortedMedia = [...currentMedia].sort((a, b) => {
      const slotA = imageSlots[a.id] ?? -1;
      const slotB = imageSlots[b.id] ?? -1;
      if (slotA === -1 && slotB !== -1) return 1;
      if (slotA !== -1 && slotB === -1) return -1;
      return slotA - slotB;
    });

    let finalBody = currentBody;
    if (autoInsertMarkdown && currentMedia.length > 0) {
      const currentBlocks = splitMarkdownIntoBlocks(currentBody);
      const assembled: string[] = [];

      // Slot 0 (Cover)
      const slot0Media = currentMedia.filter((m) => (imageSlots[m.id] ?? -1) === 0);
      slot0Media.forEach((m) => {
        const tag = '!' + '[' + m.name + '](' + (m.dataUrl || m.name) + ')';
        if (!currentBody.includes(m.name) && !currentBody.includes(m.dataUrl || '')) {
          assembled.push(tag);
        }
      });

      currentBlocks.forEach((b, idx) => {
        assembled.push(b);
        const slotMedia = currentMedia.filter((m) => (imageSlots[m.id] ?? -1) === idx + 1);
        slotMedia.forEach((m) => {
          const tag = '!' + '[' + m.name + '](' + (m.dataUrl || m.name) + ')';
          if (!currentBody.includes(m.name) && !currentBody.includes(m.dataUrl || '')) {
            assembled.push(tag);
          }
        });
      });

      // Trailing slot (after all blocks)
      const endMedia = currentMedia.filter((m) => (imageSlots[m.id] ?? -1) > currentBlocks.length);
      endMedia.forEach((m) => {
        const tag = '!' + '[' + m.name + '](' + (m.dataUrl || m.name) + ')';
        if (!currentBody.includes(m.name) && !currentBody.includes(m.dataUrl || '')) {
          assembled.push(tag);
        }
      });

      finalBody = assembled.join('\n\n');
    }

    onSave(currentTitle.trim(), finalBody, sortedMedia);
    onClose();
  };

  // Helper to render media cards in a slot
  const renderSlotMedia = (slotNumber: number) => {
    const slotItems = currentMedia.filter((m) => (imageSlots[m.id] ?? -1) === slotNumber);
    if (slotItems.length === 0) return null;

    return (
      <div className="space-y-2.5 my-2">
        {slotItems.map((m, idx) => (
          <div
            key={m.id}
            draggable
            onDragStart={(e) => handleDragStart(e, m.id)}
            onDragEnd={handleDragEnd}
            className="group relative bg-[#090d15] border border-white/[0.1] hover:border-indigo-500/50 rounded-xl overflow-hidden shadow-lg transition-all cursor-grab active:cursor-grabbing"
          >
            {/* Overlay Toolbar */}
            <div className="flex items-center justify-between px-3 py-1.5 bg-black/60 backdrop-blur-md border-b border-white/[0.08] text-[11px]">
              <div className="flex items-center gap-1.5 text-gray-300">
                <span className="cursor-grab text-gray-400 font-mono tracking-tighter hover:text-white" title={_('拖拽调整位置')}>
                  ⋮⋮
                </span>
                <span className="text-indigo-400 font-semibold">{_('配图 #')}{idx + 1}</span>
                <span className="truncate max-w-[150px] text-gray-400 font-mono text-[10px]">{m.name}</span>
              </div>
              <div className="flex items-center gap-1 opacity-80 group-hover:opacity-100 transition-opacity">
                <button
                  type="button"
                  onClick={() => moveImage(m.id, -1)}
                  className="p-1 hover:bg-white/[0.1] rounded text-gray-300 hover:text-white transition"
                  title={_('上移一段')}
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" /></svg>
                </button>
                <button
                  type="button"
                  onClick={() => moveImage(m.id, 1)}
                  className="p-1 hover:bg-white/[0.1] rounded text-gray-300 hover:text-white transition"
                  title={_('下移一段')}
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                </button>
                <button
                  type="button"
                  onClick={() => moveToCover(m.id)}
                  className="px-1.5 py-0.5 hover:bg-indigo-500/20 text-indigo-300 rounded text-[10px] transition"
                  title={_('置顶封面')}
                >
                  {_('置顶封面')}
                </button>
                <button
                  type="button"
                  onClick={() => moveToEnd(m.id)}
                  className="px-1.5 py-0.5 hover:bg-indigo-500/20 text-indigo-300 rounded text-[10px] transition"
                  title={_('置底文末')}
                >
                  {_('置底文末')}
                </button>
                <button
                  type="button"
                  onClick={() => removeFromArticle(m.id)}
                  className="p-1 hover:bg-red-500/20 text-red-400 rounded transition"
                  title={_('移出正文')}
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>
            </div>

            {/* Media Content */}
            <div className="bg-[#050810] flex items-center justify-center p-2 min-h-[120px] max-h-[280px] overflow-hidden">
              {m.type.startsWith('image/') ? (
                <img src={m.dataUrl} className="max-h-[260px] w-auto max-w-full object-contain rounded shadow-sm select-none" alt={m.name} />
              ) : (
                <div className="text-gray-400 text-[12px] flex flex-col items-center gap-2 py-4">
                  <span className="text-2xl">🎬</span>
                  <span>{_('🎬 视频素材')}</span>
                  <span className="text-[10px] text-gray-500 font-mono">{m.name}</span>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    );
  };

  // Helper to render drop zone
  const renderDropZone = (slotNumber: number, label: string) => {
    const isHovered = activeDropSlot === slotNumber;
    const isDragging = draggingId !== null;

    if (!isDragging && !isHovered) {
      return (
        <div
          onDragOver={(e) => handleDragOver(e, slotNumber)}
          onDrop={(e) => handleDrop(e, slotNumber)}
          className="h-2 my-1 rounded transition-colors group flex items-center justify-center cursor-pointer opacity-0 hover:opacity-100"
          title={_('拖拽图片至此槽位')}
        >
          <div className="w-full border-t border-dashed border-indigo-500/30 group-hover:border-indigo-500/60 transition-colors" />
        </div>
      );
    }

    return (
      <div
        onDragOver={(e) => handleDragOver(e, slotNumber)}
        onDragLeave={() => setActiveDropSlot(null)}
        onDrop={(e) => handleDrop(e, slotNumber)}
        className={`my-2 py-2 px-3 border-2 border-dashed rounded-xl text-center text-[11px] font-medium transition-all duration-150 ${
          isHovered
            ? 'border-indigo-400 bg-indigo-500/20 text-indigo-200 scale-[1.01] shadow-lg shadow-indigo-500/10'
            : 'border-indigo-500/40 bg-indigo-500/5 text-indigo-400/80 animate-pulse'
        }`}
      >
        <div className="flex items-center justify-center gap-1.5">
          <svg className="w-3.5 h-3.5 animate-bounce" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" /></svg>
          <span>{label}</span>
        </div>
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-md flex items-center justify-center p-2 sm:p-4 text-white animate-fadeIn">
      <div className="bg-[#0d111d] border border-white/[0.12] rounded-2xl w-full max-w-4xl h-[94vh] flex flex-col shadow-2xl overflow-hidden">
        {/* Top Header */}
        <header className="px-3 sm:px-4 py-2.5 sm:py-3 border-b border-white/[0.08] bg-[#090d16] flex items-center justify-between gap-2 sm:gap-3 shrink-0">
          <div className="flex items-center gap-2 sm:gap-2.5 min-w-0 shrink">
            <div className="w-6 h-6 sm:w-7 sm:h-7 rounded-lg bg-gradient-to-tr from-indigo-600 via-indigo-500 to-violet-500 flex items-center justify-center shadow-md shadow-indigo-500/30 shrink-0">
              <OmniPostLogo className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-white" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 sm:gap-2">
                <h3 className="font-bold text-white text-[12px] sm:text-[13px] tracking-tight whitespace-nowrap truncate">
                  {_('真实排版预览')}
                </h3>
                <span className="px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-300 text-[9px] sm:text-[10px] font-mono shrink-0 whitespace-nowrap hidden min-[540px]:inline-block">
                  Markdown
                </span>
              </div>
              <div className="flex items-center gap-1.5 text-[10px] text-gray-400 font-mono mt-0.5 whitespace-nowrap truncate">
                <span>{wordCount} {_('字')}</span>
                <span>·</span>
                <span>{currentMedia.length} {_('图')}</span>
                <span className="hidden min-[600px]:inline">·</span>
                <span className="hidden min-[600px]:inline">{_('约')} {readingTime} {_('分钟阅读')}</span>
              </div>
            </div>
          </div>

          {/* Mode Switcher */}
          <div className="flex items-center gap-0.5 sm:gap-1 p-0.5 rounded-lg bg-[#050810] border border-white/[0.08] shrink-0">
            <button
              type="button"
              onClick={() => setViewMode('preview')}
              className={`px-2 sm:px-2.5 py-1 rounded-md text-[11px] font-medium transition flex items-center gap-1 shrink-0 whitespace-nowrap ${
                viewMode === 'preview' ? 'bg-indigo-600 text-white shadow-sm' : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              <span>👁</span>
              <span>{_('沉浸预览')}</span>
            </button>
            <button
              type="button"
              onClick={() => setViewMode('split')}
              className={`px-2 sm:px-2.5 py-1 rounded-md text-[11px] font-medium transition flex items-center gap-1 shrink-0 whitespace-nowrap ${
                viewMode === 'split' ? 'bg-indigo-600 text-white shadow-sm' : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              <span>✍️</span>
              <span>{_('对照润色')}</span>
            </button>
          </div>

          {/* Right Close & Save */}
          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
            <button
              type="button"
              onClick={onClose}
              className="hidden sm:inline-flex px-2.5 sm:px-3 py-1 rounded-lg text-[11px] text-gray-400 hover:text-white hover:bg-white/[0.06] transition shrink-0 whitespace-nowrap"
            >
              {_('取消')}
            </button>
            <button
              type="button"
              onClick={handleSave}
              className="px-2.5 sm:px-3 py-1 rounded-lg text-[11px] font-semibold bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 text-white shadow-md shadow-indigo-600/30 transition flex items-center gap-1 shrink-0 whitespace-nowrap"
              title={_('保存并应用')}
            >
              <span>✓</span>
              <span>{_('保存并应用')}</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              className="text-gray-400 hover:text-white text-base sm:text-lg p-1 transition shrink-0 leading-none"
              title={_('关闭预览窗口')}
            >
              ✕
            </button>
          </div>
        </header>

        {/* Title Editing Bar */}
        <div className="px-4 py-2 border-b border-white/[0.06] bg-[#0b0f1a] flex items-center gap-2 shrink-0">
          <span className="text-gray-500 text-[12px] font-mono select-none">#</span>
          <input
            type="text"
            value={currentTitle}
            onChange={(e) => setCurrentTitle(e.target.value)}
            placeholder={_('输入文章标题…')}
            title={_('文章标题（点击编辑）')}
            className="w-full bg-transparent text-white font-bold text-[14px] placeholder-gray-500 focus:outline-none focus:text-indigo-200 transition"
          />
        </div>

        {/* Main Body Area */}
        <div className="flex-1 overflow-hidden flex min-h-0">
          {viewMode === 'split' ? (
            /* Split View */
            <div className="w-full h-full flex divide-x divide-white/[0.08]">
              {/* Left Markdown Editor */}
              <div className="w-1/2 h-full flex flex-col bg-[#070a12]">
                <div className="px-3 py-1.5 border-b border-white/[0.06] flex items-center justify-between text-[11px] text-gray-400 font-mono gap-2">
                  <span className="truncate shrink min-w-0">{_('Markdown 正文源码')}</span>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => setSyncScroll(!syncScroll)}
                      className={`px-1.5 py-0.5 rounded text-[10px] transition flex items-center gap-1 shrink-0 whitespace-nowrap ${
                        syncScroll
                          ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/30'
                          : 'bg-white/[0.04] text-gray-500 hover:text-gray-300'
                      }`}
                      title={_('切换两栏同步滚动')}
                    >
                      <span>{syncScroll ? '🔗' : '🔓'}</span>
                      <span>{syncScroll ? _('同步滚动') : _('独立滚动')}</span>
                    </button>
                    <span className="shrink-0 whitespace-nowrap">{currentBody.length} {_('字')}</span>
                  </div>
                </div>
                <textarea
                  ref={textareaRef}
                  onScroll={handleLeftScroll}
                  value={currentBody}
                  onChange={(e) => setCurrentBody(e.target.value)}
                  placeholder={_('在此编辑 Markdown 正文，排版效果实时预览…')}
                  className="flex-1 w-full p-4 bg-transparent text-white text-[12px] font-mono leading-relaxed resize-none focus:outline-none overflow-y-auto selection:bg-indigo-500/30"
                />
                {/* 隐藏的镜像测量容器：与 textarea 保持像素级样式一致，用于精准提取每个 block 的物理垂直 offsetTop */}
                <div
                  ref={mirrorRef}
                  aria-hidden="true"
                  className="absolute -left-[9999px] top-0 pointer-events-none opacity-0 overflow-hidden text-[12px] font-mono leading-relaxed p-4 whitespace-pre-wrap break-words select-none"
                >
                  {blockChunks.map((chunk, i) => (
                    <div key={i} data-mirror-idx={i}>
                      {chunk}
                    </div>
                  ))}
                </div>
              </div>

              {/* Right Live Preview */}
              <div className="w-1/2 h-full flex flex-col bg-[#0d111d]">
                <div className="px-3 py-1.5 border-b border-white/[0.06] text-[11px] text-gray-400 font-mono flex items-center justify-between gap-2">
                  <span className="truncate shrink min-w-0">{_('排版与图片混排视图')}</span>
                  {syncScroll && (
                    <span className="text-[10px] text-indigo-400/80 font-sans flex items-center gap-1 shrink-0 whitespace-nowrap">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                      <span>{_('同步滚动中')}</span>
                    </span>
                  )}
                </div>
                <div
                  ref={previewPaneRef}
                  onScroll={handleRightScroll}
                  className="flex-1 overflow-y-auto p-4 space-y-2"
                >
                  {/* Slot 0: Cover */}
                  {renderSlotMedia(0)}
                  {renderDropZone(0, _('释放图片放置在此（文章开头封面）'))}

                  {blocks.length === 0 ? (
                    <div className="text-gray-500 text-center py-10 text-[12px]">
                      {_('暂无正文内容，请在主界面或左侧编辑区输入正文…')}
                    </div>
                  ) : (
                    blocks.map((block, idx) => (
                      <div key={idx} data-block-idx={idx} className="space-y-1">
                        <div
                          className="text-[13px] leading-relaxed text-gray-200"
                          dangerouslySetInnerHTML={{ __html: renderMarkdown(block) }}
                        />
                        {renderSlotMedia(idx + 1)}
                        {renderDropZone(idx + 1, _('释放图片放置在此（第 ') + (idx + 1) + _(' 段后）'))}
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          ) : (
            /* Immersive Preview */
            <div className="flex-1 overflow-y-auto p-4 sm:p-6 bg-[#0c101c]">
              <div className="max-w-2xl mx-auto space-y-3 pb-8">
                {/* Document Header in Preview */}
                {currentTitle.trim() && (
                  <h1 className="text-[20px] font-bold text-white tracking-tight border-b border-white/[0.1] pb-2 mb-3">
                    {currentTitle}
                  </h1>
                )}

                {/* Slot 0: Cover / Intro image */}
                {renderSlotMedia(0)}
                {renderDropZone(0, _('释放图片放置在此（文章开头封面）'))}

                {blocks.length === 0 ? (
                  <div className="text-gray-500 text-center py-12 text-[13px]">
                    {_('暂无正文内容，请在主界面或左侧编辑区输入正文…')}
                  </div>
                ) : (
                  blocks.map((block, idx) => {
                    const isEditing = editingBlockIndex === idx;
                    return (
                      <div key={idx} className="group relative space-y-1.5">
                        {isEditing ? (
                          <div className="p-2 rounded-lg bg-[#090d15] border border-indigo-500/50 space-y-2">
                            <textarea
                              value={editingBlockText}
                              onChange={(e) => setEditingBlockText(e.target.value)}
                              className="w-full h-24 p-2 bg-transparent text-white text-[13px] font-sans leading-relaxed resize-none focus:outline-none"
                            />
                            <div className="flex justify-end gap-2 text-[11px]">
                              <button
                                type="button"
                                onClick={() => setEditingBlockIndex(null)}
                                className="px-2 py-0.5 rounded text-gray-400 hover:text-white"
                              >
                                {_('取消')}
                              </button>
                              <button
                                type="button"
                                onClick={() => saveBlockEdit(idx)}
                                className="px-2 py-0.5 rounded bg-indigo-600 text-white font-medium"
                              >
                                {_('保存修改')}
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="relative">
                            <div
                              className="text-[13px] leading-relaxed text-gray-200"
                              dangerouslySetInnerHTML={{ __html: renderMarkdown(block) }}
                            />
                            <button
                              type="button"
                              onClick={() => startEditBlock(idx, block)}
                              className="absolute -right-2 top-0 p-1 opacity-0 group-hover:opacity-100 transition-opacity rounded bg-white/[0.06] hover:bg-white/[0.12] text-gray-400 hover:text-white text-[10px] flex items-center gap-0.5"
                              title={_('编辑本段')}
                            >
                              <span>✎</span>
                              <span>{_('编辑本段')}</span>
                            </button>
                          </div>
                        )}

                        {/* Slot after this block */}
                        {renderSlotMedia(idx + 1)}
                        {renderDropZone(idx + 1, _('释放图片放置在此（第 ') + (idx + 1) + _(' 段后）'))}
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}
        </div>

        {/* Media Shelf / Drawer */}
        <div className="border-t border-white/[0.08] bg-[#080b14] px-4 py-2.5 shrink-0 space-y-2">
          <div className="flex items-center justify-between text-[11px] gap-2">
            <div className="flex items-center gap-2 min-w-0 shrink">
              <span className="font-semibold text-gray-300 whitespace-nowrap shrink-0">{_('已上传媒体图库')}</span>
              <span className="px-1.5 py-0.5 rounded-full bg-white/[0.06] text-gray-400 font-mono text-[10px] shrink-0">
                {currentMedia.length}
              </span>
              <span className="text-gray-500 text-[10px] hidden md:inline truncate">
                {_('可将图片拖拽至上方各段落槽位，或使用右侧快捷排版')}
              </span>
            </div>

            {currentMedia.length > 0 && (
              <div className="flex items-center gap-1 sm:gap-1.5 shrink-0 overflow-x-auto">
                <button
                  type="button"
                  onClick={distributeEvenly}
                  className="px-2 py-0.5 rounded text-[10px] bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-300 border border-indigo-500/20 transition whitespace-nowrap shrink-0"
                >
                  ⚡ {_('一键均分插入正文')}
                </button>
                <button
                  type="button"
                  onClick={moveAllToEnd}
                  className="px-2 py-0.5 rounded text-[10px] bg-white/[0.04] hover:bg-white/[0.08] text-gray-300 transition whitespace-nowrap shrink-0"
                >
                  📥 {_('全部移至文末')}
                </button>
                <button
                  type="button"
                  onClick={removeAllFromArticle}
                  className="px-2 py-0.5 rounded text-[10px] hover:bg-red-500/10 text-red-400 transition whitespace-nowrap shrink-0"
                >
                  🔄 {_('全部移出正文')}
                </button>
              </div>
            )}
          </div>

          {/* Media Items Horizontal Strip */}
          {currentMedia.length > 0 ? (
            <div className="flex items-center gap-2 overflow-x-auto pb-1">
              {currentMedia.map((m, i) => {
                const slot = imageSlots[m.id] ?? -1;
                let slotLabel = _('未放置（点击或拖拽插入）');
                if (slot === 0) slotLabel = _('位于封面');
                else if (slot > 0 && slot < blocks.length) slotLabel = _('位于第 ') + slot + _(' 段后');
                else if (slot >= blocks.length && blocks.length > 0) slotLabel = _('位于文末');

                return (
                  <div
                    key={m.id}
                    draggable
                    onDragStart={(e) => handleDragStart(e, m.id)}
                    onDragEnd={handleDragEnd}
                    onClick={() => {
                      if (slot === -1) {
                        // Click to place at next available slot or end
                        setImageSlots((prev) => ({ ...prev, [m.id]: Math.min(blocks.length, i + 1) }));
                      }
                    }}
                    className={`relative group shrink-0 w-24 rounded-lg border p-1 cursor-grab active:cursor-grabbing transition-all ${
                      slot >= 0
                        ? 'bg-indigo-950/20 border-indigo-500/40 hover:border-indigo-400'
                        : 'bg-[#0b0e18] border-white/[0.08] hover:border-white/[0.2] opacity-75 hover:opacity-100'
                    }`}
                  >
                    <div className="w-full h-12 rounded bg-black/40 overflow-hidden flex items-center justify-center">
                      {m.type.startsWith('image/') ? (
                        <img src={m.dataUrl} className="w-full h-full object-cover" alt={m.name} />
                      ) : (
                        <span className="text-xs">🎬</span>
                      )}
                    </div>
                    <div className="mt-1 text-[9px] truncate font-mono text-gray-400 text-center">{m.name}</div>
                    <div className="text-[9px] text-center font-medium mt-0.5 text-indigo-300 truncate">
                      {slotLabel}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="py-2 text-center text-[10px] text-gray-500 font-sans">
              {_('暂无已上传媒体文件，可在主界面上传图片')}
            </div>
          )}
        </div>

        {/* Modal Bottom Bar */}
        <footer className="px-4 py-2.5 border-t border-white/[0.08] bg-[#070a12] flex items-center justify-between shrink-0 text-[11px] gap-2">
          <label className="flex items-center gap-2 cursor-pointer text-gray-300 hover:text-white select-none min-w-0">
            <input
              type="checkbox"
              checked={autoInsertMarkdown}
              onChange={(e) => setAutoInsertMarkdown(e.target.checked)}
              className="rounded bg-[#050810] border-white/[0.2] text-indigo-600 focus:ring-indigo-500/30 shrink-0"
            />
            <span className="truncate">{_('保存时将图片排版转为 Markdown 语法 (![图片](...))')}</span>
          </label>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg border border-white/[0.1] hover:bg-white/[0.06] text-gray-300 font-medium transition whitespace-nowrap shrink-0"
            >
              {_('取消')}
            </button>
            <button
              type="button"
              onClick={handleSave}
              className="px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-semibold shadow-md shadow-indigo-600/30 transition flex items-center gap-1.5 whitespace-nowrap shrink-0"
            >
              <span>✨</span>
              <span>{_('保存并应用')}</span>
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
};
