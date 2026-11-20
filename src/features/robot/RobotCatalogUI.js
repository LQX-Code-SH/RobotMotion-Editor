/**
 * 机型预览选择器：网页左上角的下拉列表。
 *
 * 读取 robot/index.json（由 scripts/generate-robot-index.mjs 生成），
 * 按"机器人型号-末端执行器"标识各机型变体（如 walker-tienkung-dex-inspire），
 * 选中后从服务端加载对应 URDF 并交给现有模型加载流程渲染。
 */
const CUSTOM_VALUE = '__custom_model__';

export class RobotCatalogUI {
    constructor({ fileHandler, onSelect = null }) {
        this.fileHandler = fileHandler;
        this.onSelect = onSelect;   // (entry|null) 机型变体切换时通知外部（末端类型校验）
        this.entries = [];
        this.currentId = null;
        this.loading = false;
        this.folderInput = null;
    }

    async init() {
        const select = document.getElementById('robot-catalog-select');
        if (!select) return;

        select.addEventListener('change', () => {
            const id = select.value;
            if (id === CUSTOM_VALUE) {
                this.openCustomModelPicker();
                select.value = this.currentId || '';
                return;
            }
            if (id) this.select(id);
        });

        try {
            const indexUrl = new URL('robot/index.json', document.baseURI).href;
            const response = await fetch(indexUrl);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const index = await response.json();
            this.entries = index.robots || [];
            this.render(select);
        } catch (error) {
            console.warn('[robot-catalog] 机型索引加载失败:', error);
            select.innerHTML = '<option value="">机型索引不可用</option>';
            select.disabled = true;
        }
    }

    render(select) {
        const groups = new Map();
        for (const entry of this.entries) {
            if (!groups.has(entry.model)) groups.set(entry.model, []);
            groups.get(entry.model).push(entry);
        }

        let html = '<option value="">选择机型…</option>';
        html += `<option value="${CUSTOM_VALUE}">${escapeHtml(
            window.i18n?.t('catalogCustom') || '＋ 新建机型 / 自定义机型…'
        )}</option>`;
        for (const [model, list] of groups) {
            const displayName = list[0].displayName || model;
            html += `<optgroup label="${escapeHtml(displayName)}">`;
            for (const entry of list) {
                html += `<option value="${escapeHtml(entry.id)}">${escapeHtml(entry.label)}</option>`;
            }
            html += '</optgroup>';
        }
        select.innerHTML = html;
        select.disabled = false;
    }

    async select(id) {
        if (this.loading) return;
        const entry = this.entries.find(item => item.id === id);
        if (!entry) return;

        this.loading = true;
        this.setStatus('加载中…', true);
        const select = document.getElementById('robot-catalog-select');
        if (select) select.disabled = true;

        try {
            await this.fileHandler.loadModelFromUrl({
                url: entry.urdf,
                name: entry.urdf.split('/').pop()
            });
            this.currentId = entry.id;
            this.setStatus(entry.label, false);
            this.onSelect?.(entry);
        } catch (error) {
            console.error('[robot-catalog] 机型加载失败:', error);
            this.currentId = null;
            this.setStatus(`加载失败: ${error.message}`, false, true);
            if (select) select.value = '';
        } finally {
            this.loading = false;
            if (select) select.disabled = false;
        }
    }

    /**
     * “新建机型 / 自定义机型”：打开文件面板并弹出文件夹选择框。
     * 选中的文件会以 drop 事件交给现有文件加载流程（与文件面板的“Load Folder”一致）。
     */
    openCustomModelPicker() {
        this.openFilesPanel();
        this.pickFolder();
    }

    openFilesPanel() {
        const panel = document.getElementById('floating-files-panel');
        const button = document.getElementById('toggle-files-panel');
        if (!panel) return;
        const visible = panel.style.display !== 'none'
            && getComputedStyle(panel).display !== 'none'
            && panel.style.opacity !== '0';
        if (!visible) button?.click();
    }

    pickFolder() {
        if (!this.folderInput) {
            const input = document.createElement('input');
            input.type = 'file';
            input.multiple = true;
            input.webkitdirectory = true;
            input.hidden = true;
            input.addEventListener('change', (event) => {
                const files = Array.from(event.target.files || []);
                if (files.length) {
                    const dataTransfer = new DataTransfer();
                    files.forEach((file) => dataTransfer.items.add(file));
                    document.body.dispatchEvent(new DragEvent('drop', {
                        bubbles: true,
                        cancelable: true,
                        dataTransfer
                    }));
                }
                input.value = '';
            });
            document.body.appendChild(input);
            this.folderInput = input;
        }
        this.folderInput.click();
    }

    setStatus(text, loading = false, isError = false) {
        const el = document.getElementById('robot-catalog-status');
        if (!el) return;
        el.textContent = text;
        el.classList.toggle('loading', loading);
        el.classList.toggle('error', isError);
    }
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
