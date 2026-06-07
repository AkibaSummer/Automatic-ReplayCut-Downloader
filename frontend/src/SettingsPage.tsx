import type { AxiosInstance } from 'axios'
import { FolderOpen, RefreshCcw, Settings } from 'lucide-react'
import type { Config } from './types'

export interface SettingsPageProps {
  config: Config | null
  setConfig: (c: Config) => void
  savingConfig: boolean
  handleSaveConfig: () => void
  handleQuitApp: () => void
  backendOnline: boolean
  paused: boolean
  openDirModal: () => void
  t: (key: string, options?: any) => string
}

export function SettingsPage({
  config,
  setConfig,
  savingConfig,
  handleSaveConfig,
  handleQuitApp,
  backendOnline,
  paused,
  openDirModal,
  t,
}: SettingsPageProps) {

  const pickDir = async (currentPath: string, onPicked: (p: string) => void) => {
    const picked = await window.desktopAPI?.pickFolder?.(currentPath)
    if (picked) onPicked(picked)
  }

  return (
    <div className="max-w-5xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6">
        <div>
          <div className="text-2xl font-bold tracking-tight">{t('settings.configTitle')}</div>
          <div className="text-sm text-slate-500 mt-1">{t('settings.configDesc')}</div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={handleQuitApp}
            className="flex items-center px-4 py-2 bg-white border border-slate-300 text-slate-700 rounded-lg font-medium transition hover:bg-slate-50"
          >
            {t('settings.quitApp')}
          </button>
          <button
            onClick={handleSaveConfig}
            disabled={!backendOnline || paused || savingConfig || !config}
            className="flex items-center px-4 py-2 bg-[var(--color-bili-pink)] hover:opacity-90 text-white rounded-lg font-medium transition disabled:opacity-50"
          >
            <RefreshCcw className={`w-4 h-4 mr-2 ${savingConfig ? 'animate-spin' : ''}`} />
            {savingConfig ? t('settings.saving') : t('common.save')}
          </button>
        </div>
      </div>

      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden mb-6">
        <div className="bg-slate-50 px-6 py-4 border-b border-slate-200 flex items-center">
          <Settings className="w-5 h-5 text-slate-500 mr-2" />
          <h2 className="font-semibold">{t('settings.systemConfig')}</h2>
        </div>

        {!config ? (
          <div className="p-6 text-slate-500">Loading…</div>
        ) : (
          <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">{t('settings.anchorId')}</label>
              <input
                value={config.bilibili.anchor_id || 0}
                onChange={e => setConfig({ ...config, bilibili: { ...config.bilibili, anchor_id: parseInt(e.target.value || '0') } })}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[var(--color-bili-pink)] focus:border-transparent outline-none transition"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">{t('settings.outputDir')}</label>
              <div className="flex gap-2">
                <input
                  value={config.download.output_dir || ''}
                  onChange={e => setConfig({ ...config, download: { ...config.download, output_dir: e.target.value } })}
                  className="flex-1 px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[var(--color-bili-pink)] focus:border-transparent outline-none transition"
                />
                <button
                  type="button"
                  onClick={() => pickDir(config.download.output_dir || '', p => setConfig({ ...config, download: { ...config.download, output_dir: p } }))}
                  disabled={!backendOnline}
                  className="px-3 py-2 bg-white border border-slate-300 text-sm font-medium rounded-lg hover:bg-slate-50 transition disabled:opacity-50 flex items-center gap-1.5"
                >
                  <FolderOpen className="w-4 h-4" />
                  {t('common.browse')}
                </button>
              </div>
              <div className="text-xs text-slate-500 mt-1">{t('settings.outputTip')}</div>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">{t('common.saveTo')} (Clip)</label>
              <div className="flex gap-2">
                <input
                  value={config.download.clip_output_dir || ''}
                  onChange={e => setConfig({ ...config, download: { ...config.download, clip_output_dir: e.target.value } })}
                  className="flex-1 px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[var(--color-bili-pink)] focus:border-transparent outline-none transition"
                />
                <button
                  type="button"
                  onClick={() => pickDir(config.download.clip_output_dir || '', p => setConfig({ ...config, download: { ...config.download, clip_output_dir: p } }))}
                  disabled={!backendOnline}
                  className="px-3 py-2 bg-white border border-slate-300 text-sm font-medium rounded-lg hover:bg-slate-50 transition disabled:opacity-50 flex items-center gap-1.5"
                >
                  <FolderOpen className="w-4 h-4" />
                  {t('common.browse')}
                </button>
              </div>
            </div>

            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-1">{t('settings.filenameTpl')}</label>
              <input
                value={config.download.filename_template || ''}
                onChange={e => setConfig({ ...config, download: { ...config.download, filename_template: e.target.value } })}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg font-mono text-sm focus:ring-2 focus:ring-[var(--color-bili-pink)] focus:border-transparent outline-none transition"
              />
              <div className="text-xs text-slate-500 mt-1">
                {'{yy}'} {'{MM}'} {'{dd}'} {'{start:150405}'} {'{title}'} {'{live_key}'} {'{start}'} {'{end}'}
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">{t('settings.maxTasks')}</label>
              <input
                value={config.download.max_concurrent_tasks || 1}
                onChange={e => setConfig({ ...config, download: { ...config.download, max_concurrent_tasks: parseInt(e.target.value || '1') } })}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[var(--color-bili-pink)] focus:border-transparent outline-none transition"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">{t('settings.segConc')}</label>
              <input
                value={config.download.concurrent_segments || 1}
                onChange={e => setConfig({ ...config, download: { ...config.download, concurrent_segments: parseInt(e.target.value || '1') } })}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[var(--color-bili-pink)] focus:border-transparent outline-none transition"
              />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
