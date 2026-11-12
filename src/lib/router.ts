import { useEffect, useState } from 'react';

/** 小さな画面の切り替え（/、/cases、/themes、/themes/{テーマ名}）。あとで会社ページ /c/{会社ID} も */
export function useRoute(): string {
  const [path, setPath] = useState(() => decodeURIComponent(location.pathname));
  useEffect(() => {
    const on = () => setPath(decodeURIComponent(location.pathname));
    addEventListener('popstate', on);
    return () => removeEventListener('popstate', on);
  }, []);
  return path;
}

export function navigate(path: string) {
  if (decodeURIComponent(location.pathname) === path) return;
  history.pushState(null, '', encodeURI(path));
  dispatchEvent(new PopStateEvent('popstate'));
  scrollTo(0, 0);
}

/** <a> を押したときにページを読み直さずに切り替える */
export function linkProps(path: string) {
  return {
    href: encodeURI(path),
    onClick: (e: React.MouseEvent) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      navigate(path);
    },
  };
}
