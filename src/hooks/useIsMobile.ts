// 📱 Shared responsive breakpoint hook — single source of truth for the app.
// Matches the breakpoints used by the App shell (mobile ≤ 1024).
import { useEffect, useState } from 'react';

export type Breakpoint = 'phone' | 'tablet' | 'desktop';

const PHONE_MAX = 600;
const TABLET_MAX = 1024;

function compute(width: number): { isPhone: boolean; isTablet: boolean; isMobile: boolean; breakpoint: Breakpoint } {
  const isPhone = width <= PHONE_MAX;
  const isTablet = width > PHONE_MAX && width <= TABLET_MAX;
  return {
    isPhone,
    isTablet,
    isMobile: width <= TABLET_MAX, // phone OR tablet
    breakpoint: isPhone ? 'phone' : isTablet ? 'tablet' : 'desktop',
  };
}

/**
 * Returns live responsive state that updates on resize.
 *   const { isMobile, isPhone, isTablet, breakpoint } = useIsMobile();
 */
export function useIsMobile() {
  const [state, setState] = useState(() =>
    compute(typeof window !== 'undefined' ? window.innerWidth : 1280)
  );

  useEffect(() => {
    const onResize = () => setState(compute(window.innerWidth));
    window.addEventListener('resize', onResize);
    onResize();
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return state;
}

export default useIsMobile;
