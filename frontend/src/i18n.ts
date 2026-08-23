import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import en from './locales/en.json';
import zh from './locales/zh.json';

let savedLang: string | null = null;
try {
  savedLang = localStorage.getItem('lang');
} catch (error) {
  // Storage can be unavailable for file:// pages under restrictive Windows or
  // enterprise policies. Language preference failure must never block React.
  console.warn('[i18n] Unable to read saved language:', error);
}
const defaultLang = savedLang === 'en' ? 'en' : 'zh';

i18n
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      zh: { translation: zh }
    },
    lng: defaultLang,
    fallbackLng: 'zh',
    interpolation: {
      escapeValue: false // React already escapes by default
    }
  });

export default i18n;
