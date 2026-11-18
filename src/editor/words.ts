/**
 * The texts the editor setup shows itself (status bar, uploads, preview),
 * plus the plugins' block labels and the panel buttons' tooltips. English
 * is the key; luna-dashboard passes its own catalogue's translations, the
 * studio uses the built-in Russian below.
 */
export const WORDS = {
  uploadFailed: 'Upload failed:',
  imagesOnly: 'Only images can be used here.',
  saving: 'Saving…',
  offline: 'Offline: changes wait in this browser and go out when luna-pages is back.',
  error: 'Saving failed; retrying. See the console.',
  conflict: 'Changed elsewhere: resolve the conflict in the panel.',
  saved: 'All changes saved',
  noCustomCode: "Scripts and stylesheet links were left out: the site does not allow custom code (custom_code in the site's settings).",
  /** {name} — the field */
  fieldNoElement: 'The field {name} has no element in the template.',
  publishedWarnings: 'Published with warnings:',
  published: 'Published',
  openFirst: 'Open a page or an entry first.',
  noPreview: 'Layouts, templates and the site have no preview: open a page.',
  exportZip: 'Export ZIP',
  desktop: 'Desktop',
  tablet: 'Tablet',
  mobile: 'Mobile',
};

export type Words = typeof WORDS;

/** The plugins' block labels and categories as they name them. */
export const BLOCK_LABELS = [
  'Basic', 'Forms', 'forms', 'Extra', 'Storage',
  'Link Block', 'Quote', 'Text section', '1 Column', '2 Columns', '3 Columns', '2 Columns 3/7',
  'Text', 'Link', 'Image', 'Video', 'Map',
  'Form', 'Input', 'Textarea', 'Select', 'Button', 'Checkbox', 'Radio',
  'Navbar', 'Tabs', 'Countdown', 'Custom Code', 'Tooltip', 'Typed', 'My files',
];

/** Tooltips of the panel buttons, by button id. */
export const BUTTON_TITLES: Record<string, string> = {
  'set-device-desktop': 'Desktop', 'set-device-tablet': 'Tablet', 'set-device-mobile': 'Mobile',
  'sw-visibility': 'Show element borders', preview: 'Preview the design', fullscreen: 'Full screen',
  'export-template': 'View code', undo: 'Undo', redo: 'Redo', 'gjs-open-import-webpage': 'Import HTML',
  'canvas-clear': 'Clear the canvas', 'gca-open-picker-btn': 'Insert from cloud',
  'open-sm': 'Styles', 'open-tm': 'Settings of the element', 'open-layers': 'Layers', 'open-blocks': 'Blocks',
  'pages-manager': 'Pages', 'content-storage': 'Content',
};

/** Russian, as luna-dashboard's catalogue (app/locale/ru.go) has it. */
export const RU: Record<string, string> = {
  'Upload failed:': 'Загрузка не удалась:',
  'Only images can be used here.': 'Здесь можно использовать только изображения.',
  'Saving…': 'Сохранение…',
  'Offline: changes wait in this browser and go out when luna-pages is back.': 'Нет связи: изменения ждут в этом браузере и уйдут, когда luna-pages вернётся.',
  'Saving failed; retrying. See the console.': 'Не удалось сохранить; повторяем. Подробности в консоли.',
  'Changed elsewhere: resolve the conflict in the panel.': 'Изменено в другом месте: разрешите конфликт в панели.',
  'All changes saved': 'Все изменения сохранены',
  "Scripts and stylesheet links were left out: the site does not allow custom code (custom_code in the site's settings).":
    'Скрипты и ссылки на стили не опубликованы: сайт не разрешает свой код (custom_code в настройках сайта).',
  'The field {name} has no element in the template.': 'У поля {name} нет элемента в шаблоне.',
  'Published with warnings:': 'Опубликовано, но есть замечания:',
  Published: 'Опубликовано',
  'Open a page or an entry first.': 'Сначала откройте страницу или запись.',
  'Layouts, templates and the site have no preview: open a page.': 'У макетов, шаблонов и сайта нет предпросмотра: откройте страницу.',
  'Export ZIP': 'Экспорт ZIP',
  Basic: 'Основные', Forms: 'Формы', forms: 'Формы', Extra: 'Дополнительно', Storage: 'Хранилища',
  'Link Block': 'Блок-ссылка', Quote: 'Цитата', 'Text section': 'Текстовый раздел', '1 Column': '1 колонка',
  '2 Columns': '2 колонки', '3 Columns': '3 колонки', '2 Columns 3/7': '2 колонки 3/7',
  Text: 'Текст', Link: 'Ссылка', Image: 'Изображение', Video: 'Видео', Map: 'Карта',
  Form: 'Форма', Input: 'Поле ввода', Textarea: 'Многострочное поле', Select: 'Список', Button: 'Кнопка',
  Checkbox: 'Флажок', Radio: 'Переключатель', Navbar: 'Меню', Tabs: 'Вкладки', Countdown: 'Обратный отсчёт',
  'Custom Code': 'Свой код', Tooltip: 'Подсказка', Typed: 'Печатный текст', 'My files': 'Мои файлы',
  Desktop: 'Компьютер', Tablet: 'Планшет', Mobile: 'Телефон',
  'Show element borders': 'Показать границы элементов', 'Preview the design': 'Просмотр дизайна',
  'Full screen': 'Во весь экран', 'View code': 'Показать код', Undo: 'Отменить', Redo: 'Повторить',
  'Import HTML': 'Импорт HTML', 'Clear the canvas': 'Очистить холст', 'Insert from cloud': 'Вставить из облака',
  Styles: 'Стили', 'Settings of the element': 'Настройки элемента', Layers: 'Слои', Blocks: 'Блоки',
  Pages: 'Страницы', Content: 'Контент',
};

/** A translator over a catalogue (English text → translation). */
export const translator =
  (catalogue: Record<string, string> = {}) =>
  (s: string): string =>
    catalogue[s] || s;

/** The words, labels and titles of a language from a catalogue. */
export function localized(catalogue: Record<string, string> = {}): {
  words: Words;
  labels: Record<string, string>;
  titles: Record<string, string>;
} {
  const t = translator(catalogue);
  const words = Object.fromEntries(Object.entries(WORDS).map(([k, v]) => [k, t(v)])) as Words;
  const labels: Record<string, string> = {};
  BLOCK_LABELS.forEach((l) => {
    if (t(l) !== l) labels[l] = t(l);
  });
  const titles = Object.fromEntries(Object.entries(BUTTON_TITLES).map(([id, s]) => [id, t(s)]));
  return { words, labels, titles };
}
