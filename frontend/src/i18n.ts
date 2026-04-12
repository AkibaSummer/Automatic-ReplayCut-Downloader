import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import en from './locales/en.json';
import zh from './locales/zh.json';

const savedLang = localStorage.getItem('lang');
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
