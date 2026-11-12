import { useRef } from 'react';

/** 検索窓。入力した言葉は × ボタン（または Esc キー）で一度に消せる */
export function SearchBox({ value, onChange, placeholder, onSubmit }: { value: string; onChange: (v: string) => void; placeholder: string; onSubmit?: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const clear = () => {
    onChange('');
    ref.current?.focus();
  };
  return (
    <div className="searchbox" role="search">
      <svg className="searchicon" viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" strokeWidth="2" />
        <line x1="12.6" y1="12.6" x2="17" y2="17" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <input
        ref={ref}
        type="search"
        enterKeyHint="search"
        placeholder={placeholder}
        aria-label="検索"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // Enter で探す（日本語の変換中の Enter は除く）
          if (e.key === 'Enter' && onSubmit && !e.nativeEvent.isComposing) {
            e.preventDefault();
            onSubmit();
            return;
          }
          if (e.key === 'Escape' && value) {
            e.preventDefault();
            clear();
          }
        }}
      />
      {value && (
        <button type="button" className="searchclear" aria-label="検索した言葉をすべて消す" title="検索した言葉をすべて消す" onClick={clear}>
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <line x1="5" y1="5" x2="15" y2="15" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
            <line x1="15" y1="5" x2="5" y2="15" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
          </svg>
        </button>
      )}
    </div>
  );
}
