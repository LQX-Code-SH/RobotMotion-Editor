/**
 * UI Controller - Manages all UI panels and button interactions
 */
import * as THREE from 'three';

export class UIController {
    constructor(sceneManager) {
        this.sceneManager = sceneManager;
        this.angleUnit = 'rad';
    }

    /**
     * Setup control panel events
     */
    setupControlPanel() {
        const showVisualBtn = document.getElementById('show-visual');
        const showCollisionBtn = document.getElementById('show-collision');
        const showComBtn = document.getElementById('show-com');
        const showInertiaBtn = document.getElementById('show-inertia');
        const ignoreLimitsBtn = document.getElementById('ignore-limits');

        // Helper function: toggle button state
        const toggleButton = (button, callback) => {
            if (!button) return;

            const isActive = button.classList.contains('active');
            const newState = !isActive;

            if (newState) {
                button.classList.add('active');
            } else {
                button.classList.remove('active');
            }

            button.setAttribute('data-checked', newState.toString());

            if (callback) {
                callback(newState);
            }
        };

        // Sync initial state to sceneManager
        if (this.sceneManager && showVisualBtn) {
            const isChecked = showVisualBtn.classList.contains('active');
            this.sceneManager.visualizationManager.showVisual = isChecked;
        }
        if (this.sceneManager && showCollisionBtn) {
            this.sceneManager.visualizationManager.showCollision = showCollisionBtn.classList.contains('active');
        }
        if (this.sceneManager && showComBtn) {
            this.sceneManager.inertialVisualization.showCOM = showComBtn.classList.contains('active');
        }
        if (this.sceneManager && showInertiaBtn) {
            this.sceneManager.inertialVisualization.showInertia = showInertiaBtn.classList.contains('active');
        }
        if (this.sceneManager && ignoreLimitsBtn) {
            this.sceneManager.ignoreLimits = !ignoreLimitsBtn.classList.contains('active');
        }

        // Display options event listeners
        if (showVisualBtn) {
            showVisualBtn.addEventListener('click', () => {
                toggleButton(showVisualBtn, (newState) => {
                    this.sceneManager.visualizationManager.toggleVisual(newState, this.sceneManager.currentModel);

                    // If MuJoCo simulation is running, also toggle its visual display
                    const mujocoManager = window.app?.mujocoSimulationManager;
                    if (mujocoManager && mujocoManager.hasScene()) {
                        mujocoManager.toggleVisualDisplay(newState);
                    }

                    this.sceneManager.redraw();
                    this.sceneManager.render();
                });
            });
        }

        if (showCollisionBtn) {
            showCollisionBtn.addEventListener('click', () => {
                toggleButton(showCollisionBtn, (newState) => {
                    this.sceneManager.visualizationManager.toggleCollision(newState);

                    // If MuJoCo simulation is running, also toggle its collision display
                    const mujocoManager = window.app?.mujocoSimulationManager;
                    if (mujocoManager && mujocoManager.hasScene()) {
                        mujocoManager.toggleCollisionDisplay(newState);
                    }

                    this.sceneManager.redraw();
                    this.sceneManager.render();
                });
            });
        }

        if (showComBtn) {
            showComBtn.addEventListener('click', () => {
                toggleButton(showComBtn, (newState) => {
                    this.sceneManager.inertialVisualization.toggleCenterOfMass(newState, this.sceneManager.currentModel);

                    // If MuJoCo simulation is running, also toggle its COM display
                    const mujocoManager = window.app?.mujocoSimulationManager;
                    if (mujocoManager && mujocoManager.hasScene()) {
                        mujocoManager.toggleCOMDisplay(newState);
                    }

                    this.sceneManager.updateVisualTransparency();
                    this.sceneManager.redraw();
                    this.sceneManager.render();
                });
            });
        }

        if (showInertiaBtn) {
            showInertiaBtn.addEventListener('click', () => {
                toggleButton(showInertiaBtn, (newState) => {
                    this.sceneManager.inertialVisualization.toggleInertia(newState, this.sceneManager.currentModel);

                    // If MuJoCo simulation is running, also toggle its inertia display
                    const mujocoManager = window.app?.mujocoSimulationManager;
                    if (mujocoManager && mujocoManager.hasScene()) {
                        mujocoManager.toggleInertiaDisplay(newState);
                    }

                    this.sceneManager.redraw();
                    this.sceneManager.render();
                });
            });
        }

        if (ignoreLimitsBtn) {
            ignoreLimitsBtn.addEventListener('click', () => {
                toggleButton(ignoreLimitsBtn, (newState) => {
                    this.sceneManager.setIgnoreLimits(!newState);
                    this.onIgnoreLimitsChanged?.(!newState);
                });
            });
        }

        // Coordinate system direction toggle
        const upSelect = document.getElementById('up-select');
        if (upSelect) {
            upSelect.addEventListener('change', (e) => {
                this.sceneManager.setUp(e.target.value);
                window.robotGhost?.refresh?.();
            });
        }

        // Angle unit toggle
        const unitRad = document.getElementById('unit-rad');
        const unitDeg = document.getElementById('unit-deg');

        if (unitRad) {
            unitRad.addEventListener('click', () => {
                this.angleUnit = 'rad';
                unitRad.classList.add('active');
                if (unitDeg) unitDeg.classList.remove('active');
                this.onAngleUnitChanged?.(this.angleUnit);
            });
        }

        if (unitDeg) {
            unitDeg.addEventListener('click', () => {
                this.angleUnit = 'deg';
                unitDeg.classList.add('active');
                if (unitRad) unitRad.classList.remove('active');
                this.onAngleUnitChanged?.(this.angleUnit);
            });
        }

        // Reset button
        const resetJointsBtn = document.getElementById('reset-joints-btn');
        if (resetJointsBtn) {
            resetJointsBtn.addEventListener('click', () => {
                this.onResetJoints?.();
            });
        }

        // MuJoCo simulation control buttons
        const mujocoResetBtn = document.getElementById('mujoco-reset-btn-bar');
        if (mujocoResetBtn) {
            mujocoResetBtn.addEventListener('click', () => {
                this.onMujocoReset?.();
            });
        }

        const mujocoSimulateBtn = document.getElementById('mujoco-simulate-btn-bar');
        if (mujocoSimulateBtn) {
            mujocoSimulateBtn.addEventListener('click', async () => {
                const isSimulating = await this.onMujocoToggleSimulate?.();
                if (isSimulating !== undefined) {
                    mujocoSimulateBtn.classList.toggle('active', isSimulating);
                    const span = mujocoSimulateBtn.querySelector('span');
                    if (span) {
                        // Use i18n to update button text
                        const key = isSimulating ? 'mujocoPause' : 'mujocoSimulate';
                        span.textContent = window.i18n?.t(key) || (isSimulating ? 'Pause' : 'Simulate');
                        span.setAttribute('data-i18n', key);
                    }
                }
            });
        }
    }

    /**
     * Setup theme toggle
     */
    setupThemeToggle(onThemeChanged) {
        const themeToggle = document.getElementById('theme-toggle');
        if (!themeToggle) {
            return;
        }

        const currentTheme = localStorage.getItem('theme') || 'dark';
        document.documentElement.setAttribute('data-theme', currentTheme);
        this.updateThemeIcon(currentTheme);

        if (this.sceneManager) {
            this.sceneManager.updateBackgroundColor();
        }

        themeToggle.addEventListener('click', () => {
            const currentTheme = document.documentElement.getAttribute('data-theme');
            const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
            document.documentElement.setAttribute('data-theme', newTheme);
            localStorage.setItem('theme', newTheme);
            this.updateThemeIcon(newTheme);

            if (this.sceneManager) {
                this.sceneManager.updateBackgroundColor();
            }

            onThemeChanged?.(newTheme);
        });
    }

    /**
     * Setup language toggle
     */
    setupLanguageToggle(onLanguageChanged) {
        const languageToggle = document.getElementById('language-toggle');
        if (!languageToggle) {
            return;
        }

        // Get current language from i18n
        const currentLang = window.i18n?.getCurrentLanguage() || 'zh-CN';
        this.updateLanguageIcon(currentLang);

        languageToggle.addEventListener('click', () => {
            const currentLang = window.i18n?.getCurrentLanguage() || 'zh-CN';
            const newLang = currentLang === 'zh-CN' ? 'en-US' : 'zh-CN';

            onLanguageChanged?.(newLang);
            this.updateLanguageIcon(newLang);
        });
    }

    /**
     * Update language icon
     */
    updateLanguageIcon(lang) {
        const languageToggle = document.getElementById('language-toggle');
        const text = languageToggle?.querySelector('.tool-button-text');
        if (text) {
            // Display the other language based on current language (toggle hint)
            text.textContent = lang === 'zh-CN' ? 'Language' : '语言';
        }
    }

    /**
     * Update theme icon
     */
    updateThemeIcon(theme) {
        const themeToggle = document.getElementById('theme-toggle');
        const icon = themeToggle?.querySelector('.tool-button-icon');
        if (icon) {
            icon.textContent = theme === 'dark' ? '🌙' : '☀️';
        }
    }


    /**
     * Setup panel close button functionality
     */
    setupPanelCloseButtons() {
        const panelButtonMap = {
            'floating-files-panel': 'toggle-files-panel',
            'floating-joints-panel': 'toggle-joints-panel',
            'floating-model-tree': 'toggle-model-tree',
            'floating-help-panel': 'help-button',
            'floating-robot-panel': 'toggle-robot-panel'
        };

        const closeButtons = document.querySelectorAll('.panel-close-btn');

        closeButtons.forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const panelId = btn.getAttribute('data-panel');
                const panel = document.getElementById(panelId);
                const toggleBtnId = panelButtonMap[panelId];
                const toggleBtn = toggleBtnId ? document.getElementById(toggleBtnId) : null;

                if (panel) {
                    clearTimeout(panel._visibilityTimer);
                    const isVisible = panel.style.display !== 'none';

                    if (isVisible) {
                        panel.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
                        panel.style.opacity = '0';
                        panel.style.transform = 'scale(0.95)';

                        panel._visibilityTimer = setTimeout(() => {
                            panel.style.display = 'none';
                            panel.style.opacity = '';
                            panel.style.transform = '';
                        }, 200);

                        if (toggleBtn) {
                            toggleBtn.classList.remove('active');
                        }
                    }
                }
            });
        });

        Object.entries(panelButtonMap).forEach(([panelId, buttonId]) => {
            const button = document.getElementById(buttonId);
            const panel = document.getElementById(panelId);

            if (button && panel) {
                button.addEventListener('click', () => {
                    clearTimeout(panel._visibilityTimer);
                    const isVisible = panel.style.display !== 'none' &&
                                     getComputedStyle(panel).display !== 'none' &&
                                     panel.style.opacity !== '0';

                    if (isVisible) {
                        panel.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
                        panel.style.opacity = '0';
                        panel.style.transform = 'scale(0.95)';

                        panel._visibilityTimer = setTimeout(() => {
                            panel.style.display = 'none';
                            panel.style.opacity = '';
                            panel.style.transform = '';
                        }, 200);

                        button.classList.remove('active');
                    } else {
                        panel.style.display = 'flex';
                        panel.style.opacity = '0';
                        panel.style.transform = 'scale(0.95)';

                        panel.offsetHeight;

                        panel.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
                        panel.style.opacity = '1';
                        panel.style.transform = 'scale(1)';

                        panel._visibilityTimer = setTimeout(() => {
                            panel.style.transition = '';
                        }, 200);

                        button.classList.add('active');
                    }
                });
            }
        });
    }

    /**
     * Setup coordinate axes toggle button
     */
    setupAxesToggle() {
        const axesBtn = document.getElementById('toggle-axes-btn');
        if (!axesBtn) {
            return;
        }

        axesBtn.addEventListener('click', () => {
            this.closeAxesMenus?.();
            const isChecked = axesBtn.getAttribute('data-checked') === 'true';
            const newState = !isChecked;

            axesBtn.setAttribute('data-checked', newState.toString());
            if (newState) {
                axesBtn.classList.add('active');
                this.sceneManager.axesManager.showSelectedLinkAxes();

                // If MuJoCo simulation is running, also show its axes
                const mujocoManager = window.app?.mujocoSimulationManager;
                if (mujocoManager && mujocoManager.hasScene()) {
                    mujocoManager.toggleAxesDisplay(true);
                }

                this.sceneManager.updateVisualTransparency();
                this.sceneManager.redraw();
            } else {
                axesBtn.classList.remove('active');
                this.sceneManager.axesManager.hideAllAxes();

                // If MuJoCo simulation is running, also hide its axes
                const mujocoManager = window.app?.mujocoSimulationManager;
                if (mujocoManager && mujocoManager.hasScene()) {
                    mujocoManager.toggleAxesDisplay(false);
                }

                this.sceneManager.updateVisualTransparency();
                this.sceneManager.redraw();
            }
        });
    }

    /**
     * Setup joint axes toggle button
     */
    setupJointAxesToggle() {
        const jointAxesBtn = document.getElementById('toggle-joint-axes-btn');
        if (!jointAxesBtn) {
            return;
        }

        jointAxesBtn.addEventListener('click', () => {
            this.closeAxesMenus?.();
            const isChecked = jointAxesBtn.getAttribute('data-checked') === 'true';
            const newState = !isChecked;

            jointAxesBtn.setAttribute('data-checked', newState.toString());
            if (newState) {
                jointAxesBtn.classList.add('active');
                this.sceneManager.axesManager.showSelectedJointAxes();

                // If MuJoCo simulation is running, also show its joint axes
                const mujocoManager = window.app?.mujocoSimulationManager;
                if (mujocoManager && mujocoManager.hasScene()) {
                    mujocoManager.toggleJointAxesDisplay(true);
                }

                this.sceneManager.updateVisualTransparency();
                this.sceneManager.redraw();
            } else {
                jointAxesBtn.classList.remove('active');
                this.sceneManager.axesManager.hideAllJointAxes();

                // If MuJoCo simulation is running, also hide its joint axes
                const mujocoManager = window.app?.mujocoSimulationManager;
                if (mujocoManager && mujocoManager.hasScene()) {
                    mujocoManager.toggleJointAxesDisplay(false);
                }

                this.sceneManager.updateVisualTransparency();
                this.sceneManager.redraw();
            }
        });
    }

    /**
     * 坐标轴 / 关节轴下拉菜单：按项勾选需要显示的轴。
     * 菜单挂载到 body 并使用 fixed 定位，避免被控制栏的横向滚动裁剪。
     */
    setupAxesSelectionMenu(config) {
        const caret = document.getElementById(config.caretId);
        const button = document.getElementById(config.buttonId);
        if (!caret || !button) return;

        const axesManager = () => this.sceneManager?.axesManager;
        let menu = null;

        const closeMenu = () => {
            if (menu) menu.hidden = true;
            caret.setAttribute('aria-expanded', 'false');
        };
        this._axesMenuClosers = this._axesMenuClosers || new Set();
        this._axesMenuClosers.add(closeMenu);

        const syncScene = () => {
            const manager = axesManager();
            if (!manager) return;

            const enabled = config.isEnabled(manager);
            button.setAttribute('data-checked', String(enabled));
            button.classList.toggle('active', enabled);

            const mujocoManager = window.app?.mujocoSimulationManager;
            if (mujocoManager && mujocoManager.hasScene()) {
                // MuJoCo 场景只有整组开关，按“是否还有选中的轴”同步
                config.syncMujoco?.(mujocoManager, enabled);
            }

            this.sceneManager.updateVisualTransparency();
            this.sceneManager.redraw();
        };

        const renderList = (listEl) => {
            const manager = axesManager();
            listEl.innerHTML = '';
            const names = manager ? config.getNames(manager) : [];
            if (!names.length) {
                const empty = document.createElement('div');
                empty.className = 'joint-axes-empty';
                empty.textContent = window.i18n?.t(config.emptyKey) || config.emptyText;
                listEl.appendChild(empty);
                return;
            }

            names.forEach((name) => {
                const item = document.createElement('label');
                item.className = 'joint-axes-item';

                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.checked = config.isSelected(manager, name);
                checkbox.addEventListener('change', () => {
                    config.setVisible(manager, name, checkbox.checked);
                    syncScene();
                });

                const text = document.createElement('span');
                text.textContent = name;
                text.title = `${name} · ${window.i18n?.t('axesClickHint') || '点击名称仅显示该项，勾选框可多选'}`;

                // 点名称 = 仅显示该项；点勾选框 = 多选切换
                item.title = window.i18n?.t('axesClickHint') || '点击名称仅显示该项，勾选框可多选';
                item.addEventListener('click', (event) => {
                    if (event.target === checkbox) return;
                    event.preventDefault();
                    const activeManager = axesManager();
                    if (!activeManager) return;
                    config.setAll(activeManager, false);
                    config.setVisible(activeManager, name, true);
                    renderList(listEl);
                    syncScene();
                });

                item.append(checkbox, text);
                listEl.appendChild(item);
            });
        };

        const ensureMenu = () => {
            if (menu) return menu;

            menu = document.createElement('div');
            menu.className = 'joint-axes-menu';
            menu.hidden = true;

            const head = document.createElement('div');
            head.className = 'joint-axes-menu-head';
            const title = document.createElement('span');
            title.textContent = window.i18n?.t(config.titleKey) || config.titleText;
            const allButton = document.createElement('button');
            allButton.type = 'button';
            allButton.textContent = window.i18n?.t('selectAll') || '全选';
            const noneButton = document.createElement('button');
            noneButton.type = 'button';
            noneButton.textContent = window.i18n?.t('selectNone') || '全不选';
            head.append(title, allButton, noneButton);

            const list = document.createElement('div');
            list.className = 'joint-axes-menu-list';

            allButton.addEventListener('click', () => {
                const manager = axesManager();
                if (manager) config.setAll(manager, true);
                renderList(list);
                syncScene();
            });
            noneButton.addEventListener('click', () => {
                const manager = axesManager();
                if (manager) config.setAll(manager, false);
                renderList(list);
                syncScene();
            });

            menu.append(head, list);
            menu.addEventListener('click', (event) => event.stopPropagation());
            document.body.appendChild(menu);
            return menu;
        };

        const openMenu = () => {
            this.closeAxesMenus?.(closeMenu);
            const el = ensureMenu();
            const list = el.querySelector('.joint-axes-menu-list');
            renderList(list);

            el.hidden = false;
            caret.setAttribute('aria-expanded', 'true');

            const rect = caret.getBoundingClientRect();
            const width = el.offsetWidth || 260;
            const height = el.offsetHeight || 320;
            const left = Math.min(
                Math.max(8, rect.right - width),
                Math.max(8, window.innerWidth - width - 8)
            );
            const below = rect.bottom + 8;
            const top = below + height <= window.innerHeight - 8
                ? below
                : Math.max(8, rect.top - height - 8);
            el.style.left = `${left}px`;
            el.style.top = `${top}px`;
        };

        caret.addEventListener('click', (event) => {
            event.stopPropagation();
            if (menu && !menu.hidden) closeMenu();
            else openMenu();
        });

        document.addEventListener('click', (event) => {
            if (!menu || menu.hidden) return;
            if (menu.contains(event.target) || event.target === caret) return;
            closeMenu();
        });

        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') closeMenu();
        });
    }

    /** 关闭所有轴选择下拉（可保留 except） */
    closeAxesMenus(except = null) {
        this._axesMenuClosers?.forEach((close) => {
            if (close !== except) close();
        });
    }

    setupJointAxesMenu() {
        this.setupAxesSelectionMenu({
            caretId: 'joint-axes-menu-btn',
            buttonId: 'toggle-joint-axes-btn',
            titleKey: 'jointAxesSelect',
            titleText: '要显示的关节轴',
            emptyKey: 'jointAxesEmpty',
            emptyText: '当前模型没有可显示的关节轴',
            getNames: (manager) => manager.getJointAxisNames(),
            isSelected: (manager, name) => manager.isJointAxisSelected(name),
            setVisible: (manager, name, visible) => manager.setJointAxisVisible(name, visible),
            setAll: (manager, visible) => manager.setAllJointAxesVisible(visible),
            isEnabled: (manager) => manager.showJointAxesEnabled,
            syncMujoco: (mujoco, enabled) => mujoco.toggleJointAxesDisplay(enabled)
        });
    }

    setupLinkAxesMenu() {
        this.setupAxesSelectionMenu({
            caretId: 'link-axes-menu-btn',
            buttonId: 'toggle-axes-btn',
            titleKey: 'linkAxesSelect',
            titleText: '要显示的坐标轴',
            emptyKey: 'linkAxesEmpty',
            emptyText: '当前模型没有可显示的坐标轴',
            getNames: (manager) => manager.getLinkAxesNames(),
            isSelected: (manager, name) => manager.isLinkAxesSelected(name),
            setVisible: (manager, name, visible) => manager.setLinkAxesVisible(name, visible),
            setAll: (manager, visible) => manager.setAllLinkAxesVisible(visible),
            isEnabled: (manager) => manager.showAxesEnabled,
            syncMujoco: (mujoco, enabled) => mujoco.toggleAxesDisplay(enabled)
        });
    }

    /**
     * Setup shadow toggle button
     */
    setupShadowToggle() {
        const shadowBtn = document.getElementById('toggle-shadow');
        if (!shadowBtn) {
            return;
        }

        shadowBtn.addEventListener('click', () => {
            const isChecked = shadowBtn.getAttribute('data-checked') === 'true';
            const newState = !isChecked;

            shadowBtn.setAttribute('data-checked', newState.toString());
            if (newState) {
                shadowBtn.classList.add('active');
                this.sceneManager.visualizationManager.toggleShadow(true, this.sceneManager.renderer, this.sceneManager.directionalLight);
                this.sceneManager.axesManager.ensureAxesNoShadow();
                this.sceneManager.updateEnvironment();
                this.sceneManager.redraw();
                this.sceneManager.render();
            } else {
                shadowBtn.classList.remove('active');
                this.sceneManager.visualizationManager.toggleShadow(false, this.sceneManager.renderer, this.sceneManager.directionalLight);
                this.sceneManager.redraw();
                this.sceneManager.render();
            }
        });
    }

    /**
     * Setup lighting toggle button
     */
    setupLightingToggle() {
        const lightingBtn = document.getElementById('toggle-lighting');
        if (!lightingBtn) {
            return;
        }

        lightingBtn.addEventListener('click', () => {
            const isChecked = lightingBtn.getAttribute('data-checked') === 'true';
            const newState = !isChecked;

            lightingBtn.setAttribute('data-checked', newState.toString());
            if (newState) {
                lightingBtn.classList.add('active');
                this.sceneManager.visualizationManager.toggleEnhancedLighting(true);
            } else {
                lightingBtn.classList.remove('active');
                this.sceneManager.visualizationManager.toggleEnhancedLighting(false);
            }
            this.sceneManager.redraw();
            this.sceneManager.render();
        });
    }

    /**
     * Setup ground grid toggle button
     */
    setupGridToggle() {
        const gridBtn = document.getElementById('toggle-grid');
        if (!gridBtn) {
            return;
        }

        gridBtn.addEventListener('click', () => {
            const isChecked = gridBtn.getAttribute('data-checked') === 'true';
            const newState = !isChecked;

            gridBtn.setAttribute('data-checked', newState.toString());
            gridBtn.classList.toggle('active', newState);
            this.sceneManager.setGridVisible(newState);
            this.sceneManager.render();
        });
    }

    /**
     * Setup all buttons and panels
     */
    setupAll(callbacks = {}) {
        // Save all callbacks (before setupControlPanel)
        this.onAngleUnitChanged = callbacks.onAngleUnitChanged;
        this.onIgnoreLimitsChanged = callbacks.onIgnoreLimitsChanged;
        this.onResetJoints = callbacks.onResetJoints;
        this.onMujocoReset = callbacks.onMujocoReset;
        this.onMujocoToggleSimulate = callbacks.onMujocoToggleSimulate;

        this.setupControlPanel();
        this.setupThemeToggle(callbacks.onThemeChanged);
        this.setupLanguageToggle(callbacks.onLanguageChanged);
        this.setupPanelCloseButtons();
        this.setupAxesToggle();
        this.setupJointAxesToggle();
        this.setupEndEffectorControl(callbacks.onEndEffectorControl);
        this.setupEndEffectorMenu(callbacks.endEffectorIKControls);
        this.setupJointAxesMenu();
        this.setupLinkAxesMenu();
        this.setupShadowToggle();
        this.setupLightingToggle();
        this.setupGridToggle();
    }

    /**
     * 顶部控制栏「末端控制」倒三角菜单：模式切换、腰部关节锁定、末端选择。
     */
    setupEndEffectorMenu(endEffector) {
        const caret = document.getElementById('ee-control-menu-btn');
        if (!caret || !endEffector) return;
        this._endEffector = endEffector;

        const t = (key, fallback) => window.i18n?.t(key) || fallback;
        let menu = null;

        const closeMenu = () => {
            if (!menu) return;
            menu.hidden = true;
            caret.setAttribute('aria-expanded', 'false');
        };
        this._axesMenuClosers = this._axesMenuClosers || new Set();
        this._axesMenuClosers.add(closeMenu);

        const ensureMenu = () => {
            if (menu) return menu;
            menu = document.createElement('div');
            menu.className = 'joint-axes-menu';

            const head = document.createElement('div');
            head.className = 'joint-axes-menu-head';
            const title = document.createElement('span');
            title.textContent = t('eeMenuTitle', '末端控制');
            head.appendChild(title);

            const body = document.createElement('div');
            body.className = 'ee-menu-body';

            menu.append(head, body);
            menu.hidden = true;
            menu.addEventListener('click', (event) => event.stopPropagation());
            document.body.appendChild(menu);
            return menu;
        };

        const render = () => {
            const state = endEffector.getMenuState?.() || { mode: 'translate', chains: [], waistJoints: [] };
            const el = ensureMenu();
            const body = el.querySelector('.ee-menu-body');
            body.innerHTML = '';

            // 模式：平移 / 旋转
            const modeLabel = document.createElement('div');
            modeLabel.className = 'ee-menu-label';
            modeLabel.textContent = t('eeMenuMode', '模式');
            const seg = document.createElement('div');
            seg.className = 'ee-mode-seg';
            [
                ['translate', t('eeModeTranslate', '平移')],
                ['rotate', t('eeModeRotate', '旋转')]
            ].forEach(([mode, label]) => {
                const button = document.createElement('button');
                button.type = 'button';
                button.textContent = label;
                if (state.mode === mode) button.classList.add('active');
                button.addEventListener('click', () => {
                    endEffector.setMode(mode);
                    render();
                });
                seg.appendChild(button);
            });
            body.append(modeLabel, seg);

            // 腰部关节锁定
            const waistLabel = document.createElement('div');
            waistLabel.className = 'ee-menu-label';
            waistLabel.textContent = t('eeMenuWaistLock', '锁定腰部关节');
            body.appendChild(waistLabel);

            if (!state.waistJoints.length) {
                const empty = document.createElement('div');
                empty.className = 'ee-menu-empty';
                empty.textContent = t('eeMenuNoWaist', '当前模型无腰部关节');
                body.appendChild(empty);
            }
            state.waistJoints.forEach(({ name: jointName, locked }) => {
                const item = document.createElement('label');
                item.className = 'joint-axes-item';
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.checked = locked;
                checkbox.addEventListener('change', () => {
                    endEffector.setWaistLocked(jointName, checkbox.checked);
                });
                const text = document.createElement('span');
                text.textContent = jointName;
                item.append(checkbox, text);
                body.appendChild(item);
            });

            // 末端列表（点击 3D 中的手臂也会切换）
            const chainLabel = document.createElement('div');
            chainLabel.className = 'ee-menu-label';
            chainLabel.textContent = t('eeMenuChains', '末端');
            body.appendChild(chainLabel);

            if (!state.chains.length) {
                const empty = document.createElement('div');
                empty.className = 'ee-menu-empty';
                empty.textContent = t('eeNoChains', '当前模型无可控末端');
                body.appendChild(empty);
            }
            state.chains.forEach(({ id, label, active }) => {
                const item = document.createElement('button');
                item.type = 'button';
                item.className = 'ee-chain-item';
                if (active) item.classList.add('active');
                const nameEl = document.createElement('span');
                nameEl.textContent = label;
                const tag = document.createElement('span');
                tag.className = 'ee-chain-tag';
                tag.textContent = active ? t('eeActive', '当前') : '';
                item.append(nameEl, tag);
                item.addEventListener('click', () => {
                    endEffector.selectChain(id);
                    render();
                });
                body.appendChild(item);
            });
        };

        const openMenu = () => {
            this.closeAxesMenus(closeMenu);
            render();
            menu.hidden = false;
            caret.setAttribute('aria-expanded', 'true');

            const rect = caret.getBoundingClientRect();
            const width = menu.offsetWidth || 240;
            const height = menu.offsetHeight || 260;
            const left = Math.min(
                Math.max(8, rect.right - width),
                Math.max(8, window.innerWidth - width - 8)
            );
            const below = rect.bottom + 8;
            const top = below + height <= window.innerHeight - 8
                ? below
                : Math.max(8, rect.top - height - 8);
            menu.style.left = `${left}px`;
            menu.style.top = `${top}px`;
        };

        caret.addEventListener('click', (event) => {
            event.stopPropagation();
            if (menu && !menu.hidden) closeMenu();
            else openMenu();
        });

        document.addEventListener('click', (event) => {
            if (!menu || menu.hidden) return;
            if (menu.contains(event.target) || event.target === caret) return;
            closeMenu();
        });

        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') closeMenu();
        });

        // 3D 点击切换末端 / 模式变化时同步菜单
        endEffector.onMenuChange = () => {
            if (menu && !menu.hidden) render();
        };
    }

    /**
     * 顶部控制栏「末端控制」开关：状态由 EndEffectorIKControls 回写。
     */
    setupEndEffectorControl(onToggle) {
        const button = document.getElementById('toggle-ee-control-btn');
        if (!button) return;
        button.addEventListener('click', () => {
            this.closeAxesMenus?.();
            const next = button.getAttribute('data-checked') !== 'true';
            onToggle?.(next);
        });
    }

    /**
     * Get current angle unit
     */
    getAngleUnit() {
        return this.angleUnit;
    }}

