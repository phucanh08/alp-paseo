import type { PluginTheme } from '@getpaseo/plugin';
import { Icon, ScrollView } from '@getpaseo/plugin/client/react-native';
import { useMemo, useState, type ReactNode } from 'react';
import { Pressable, Text, View, type PressableStateCallbackType } from 'react-native';

/** React Native for web reports hover too; native reports only presses. */
const hovered = (state: PressableStateCallbackType) => !!(state as { hovered?: boolean }).hovered;

/**
 * A two-column layout (ALPD §47): a fixed aside navigation on the left, and the working
 * area with a secondary menu on top. The aside has up to three levels (group, item,
 * child). It collapses to icons when the space is narrow, and the user can collapse or
 * expand it; on a phone it opens over the content from a menu button.
 */

export type NavChild = { key: string; label: string; hint?: string; tone?: 'muted' | 'accent' | 'warning' };
export type NavItem = { key: string; label: string; icon: string; count?: number; children?: NavChild[] };
export type NavGroup = { key: string; label: string; items: NavItem[] };
export type Tab = { key: string; label: string; count?: number };

/** Below this width the aside starts collapsed. */
export const COLLAPSE_BELOW = 640;
const EXPANDED = 216;
const COLLAPSED = 52;

type Props = {
  theme: PluginTheme;
  compact: boolean;
  title: string;
  subtitle?: string;
  groups: NavGroup[];
  /** The selected item and, under it, the selected child. */
  active: { item: string; child?: string };
  onSelect(item: string, child?: string): void;
  /** Path shown above the secondary menu. */
  breadcrumb: string[];
  /** Pills after the breadcrumb, such as where an entry comes from. */
  badges?: ReactNode;
  /** Buttons at the right of the working area's header. */
  actions?: ReactNode;
  /** The secondary menu. */
  tabs?: Tab[];
  tab?: string;
  onTab?(key: string): void;
  /** A bar under the content that stays in view, such as Save. */
  footer?: ReactNode;
  children: ReactNode;
  /** Starts collapsed or expanded instead of following the width; tests set it. */
  initialCollapsed?: boolean;
};

export function SideNavLayout(props: Props) {
  const { theme, compact, groups, active, onSelect } = props;
  const styles = useMemo(() => layoutStyles(theme), [theme]);
  const [width, setWidth] = useState(0);
  const [choice, setChoice] = useState<boolean | undefined>(props.initialCollapsed);
  const [open, setOpen] = useState(false);
  // Until the user chooses, the width decides.
  const collapsed = choice ?? (width > 0 && width < COLLAPSE_BELOW);
  const select = (item: string, child?: string) => { onSelect(item, child); setOpen(false); };
  const aside = (mode: 'fixed' | 'overlay') => (
    <Aside styles={styles} theme={theme} title={props.title} subtitle={props.subtitle} groups={groups} active={active} onSelect={select}
      collapsed={mode === 'fixed' && collapsed} onToggle={mode === 'fixed' ? () => setChoice(!collapsed) : () => setOpen(false)} overlay={mode === 'overlay'} />
  );
  return (
    <View style={styles.root} onLayout={event => setWidth(event.nativeEvent.layout.width)}>
      {!compact ? aside('fixed') : null}
      <View style={styles.main}>
        <View style={styles.header}>
          <View style={styles.headerRow}>
            {compact ? (
              <Pressable accessibilityRole="button" accessibilityLabel="Open navigation" onPress={() => setOpen(true)} style={styles.iconButton}>
                <Icon name="Menu" size={18} color={theme.colors.foreground} />
              </Pressable>
            ) : null}
            <View style={styles.crumbs}>
              {props.breadcrumb.map((part, index) => [
                index ? <Text key={`separator-${index}`} style={styles.crumbSeparator}>/</Text> : null,
                <Text key={`${index}-${part}`} style={index === props.breadcrumb.length - 1 ? styles.crumbCurrent : styles.crumb} numberOfLines={1}>{part}</Text>,
              ])}
              {props.badges}
            </View>
            {props.actions ? <View style={styles.actions}>{props.actions}</View> : null}
          </View>
          {props.tabs?.length ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabs}>
              {props.tabs.map(tab => {
                const on = tab.key === props.tab;
                return (
                  <Pressable key={tab.key} accessibilityRole="tab" accessibilityLabel={tab.label} accessibilityState={{ selected: on }} onPress={() => props.onTab?.(tab.key)} style={[styles.tab, on ? styles.tabOn : null]}>
                    <Text style={on ? styles.tabTextOn : styles.tabText}>{tab.label}{tab.count !== undefined ? <Text style={styles.tabCount}>{`  ${tab.count}`}</Text> : null}</Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          ) : null}
        </View>
        <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>{props.children}</ScrollView>
        {props.footer ? <View style={styles.footer}>{props.footer}</View> : null}
      </View>
      {compact && open ? (
        <View style={styles.overlay}>
          {aside('overlay')}
          <Pressable accessibilityRole="button" accessibilityLabel="Close navigation" onPress={() => setOpen(false)} style={styles.scrim} />
        </View>
      ) : null}
    </View>
  );
}

type AsideProps = {
  styles: LayoutStyles; theme: PluginTheme; title: string; subtitle?: string; groups: NavGroup[];
  active: { item: string; child?: string }; onSelect(item: string, child?: string): void;
  collapsed: boolean; onToggle(): void; overlay: boolean;
};

function Aside({ styles, theme, title, subtitle, groups, active, onSelect, collapsed, onToggle, overlay }: AsideProps) {
  const { colors } = theme;
  // An item shows its children while selected; the user may open others too.
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const tone = (value?: NavChild['tone']) => value === 'accent' ? colors.accent : value === 'warning' ? colors.statusWarning : colors.border;
  return (
    <View style={[styles.aside, { width: collapsed ? COLLAPSED : EXPANDED }, overlay ? styles.asideOverlay : null]}>
      <View style={[styles.asideHeader, collapsed ? styles.asideHeaderCollapsed : null]}>
        {!collapsed ? (
          <View style={styles.asideTitleBox}>
            <Text style={styles.asideTitle} numberOfLines={1}>{title}</Text>
            {subtitle ? <Text style={styles.asideSubtitle} numberOfLines={1}>{subtitle}</Text> : null}
          </View>
        ) : null}
        <Pressable accessibilityRole="button" accessibilityLabel={overlay ? 'Close navigation' : collapsed ? 'Expand navigation' : 'Collapse navigation'} onPress={onToggle} style={styles.iconButton}>
          <Icon name={overlay ? 'X' : collapsed ? 'PanelLeftOpen' : 'PanelLeftClose'} size={16} color={colors.foregroundMuted} />
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.asideList}>
        {groups.map(group => (
          <View key={group.key} style={styles.group}>
            {!collapsed ? <Text style={styles.groupLabel}>{group.label}</Text> : <View style={styles.groupRule} />}
            {group.items.map(item => {
              const selected = active.item === item.key;
              const expanded = !collapsed && (opened[item.key] ?? selected) && !!item.children?.length;
              return (
                <View key={item.key}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={item.label}
                    accessibilityState={{ selected: selected && !active.child }}
                    onPress={() => { onSelect(item.key); setOpened(current => ({ ...current, [item.key]: true })); }}
                    style={state => [styles.item, collapsed ? styles.itemCollapsed : null, selected ? styles.itemOn : hovered(state) ? styles.itemHover : null]}
                  >
                    {selected ? <View style={styles.itemBar} /> : null}
                    <Icon name={item.icon} size={16} color={selected ? colors.accent : colors.foregroundMuted} />
                    {!collapsed ? <Text style={[styles.itemLabel, selected ? styles.itemLabelOn : null]} numberOfLines={1}>{item.label}</Text> : null}
                    {!collapsed && item.count !== undefined ? <Text style={styles.count}>{item.count}</Text> : null}
                    {!collapsed && item.children?.length ? (
                      <Pressable accessibilityRole="button" accessibilityLabel={`${expanded ? 'Hide' : 'Show'} ${item.label}`} hitSlop={8} onPress={() => setOpened(current => ({ ...current, [item.key]: !expanded }))}>
                        <Icon name={expanded ? 'ChevronDown' : 'ChevronRight'} size={14} color={colors.foregroundMuted} />
                      </Pressable>
                    ) : null}
                  </Pressable>
                  {expanded ? (
                    <View style={styles.children}>
                      {item.children!.map(child => {
                        const on = selected && active.child === child.key;
                        return (
                          <Pressable key={child.key} accessibilityRole="button" accessibilityLabel={`${item.label} ${child.label}`} accessibilityState={{ selected: on }} onPress={() => onSelect(item.key, child.key)}
                            style={state => [styles.child, on ? styles.childOn : hovered(state) ? styles.itemHover : null]}>
                            <View style={[styles.dot, { backgroundColor: tone(child.tone) }]} />
                            <Text style={[styles.childLabel, on ? styles.itemLabelOn : null]} numberOfLines={1}>{child.label}</Text>
                            {child.hint ? <Text style={styles.childHint} numberOfLines={1}>{child.hint}</Text> : null}
                          </Pressable>
                        );
                      })}
                    </View>
                  ) : null}
                </View>
              );
            })}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

/** A small rounded label: where an entry comes from, a state, a count. */
export function Pill({ theme, label, tone = 'muted' }: { theme: PluginTheme; label: string; tone?: 'muted' | 'accent' | 'success' | 'warning' | 'danger' }) {
  const { colors } = theme;
  const color = tone === 'accent' ? colors.accent : tone === 'success' ? colors.statusSuccess : tone === 'warning' ? colors.statusWarning : tone === 'danger' ? colors.statusDanger : colors.foregroundMuted;
  return (
    <View style={{ borderRadius: 999, borderWidth: 1, borderColor: tone === 'muted' ? colors.border : color, paddingHorizontal: 7, paddingVertical: 1, alignSelf: 'center' }}>
      <Text style={{ color, fontSize: 11, fontWeight: '500' }}>{label}</Text>
    </View>
  );
}

/** A button: primary, plain, or danger. */
export function Button({ theme, label, onPress, kind = 'plain', icon, disabled, accessibilityLabel }: { theme: PluginTheme; label: string; onPress(): void; kind?: 'primary' | 'plain' | 'danger'; icon?: string; disabled?: boolean; accessibilityLabel?: string }) {
  const { colors } = theme;
  const color = kind === 'primary' ? colors.accentForeground : kind === 'danger' ? colors.statusDanger : colors.foreground;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? label} disabled={disabled} onPress={onPress}
      style={state => ({
        flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7, opacity: disabled ? 0.5 : 1,
        backgroundColor: kind === 'primary' ? colors.accent : hovered(state) ? colors.surface2 : colors.surface1,
        borderWidth: kind === 'primary' ? 0 : 1, borderColor: kind === 'danger' ? colors.statusDanger : colors.border,
      })}>
      {icon ? <Icon name={icon} size={14} color={color} /> : null}
      <Text style={{ color, fontSize: 13, fontWeight: kind === 'primary' ? '600' : '500' }}>{label}</Text>
    </Pressable>
  );
}

type LayoutStyles = ReturnType<typeof layoutStyles>;
function layoutStyles(theme: PluginTheme) {
  const { colors } = theme;
  return {
    root: { flex: 1, flexDirection: 'row' as const, backgroundColor: colors.surface0, minHeight: 560, borderWidth: 1, borderColor: colors.border, borderRadius: 12, overflow: 'hidden' as const },
    aside: { backgroundColor: colors.surface1, borderRightWidth: 1, borderRightColor: colors.border },
    asideOverlay: { height: '100%' as const, shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 16 },
    asideHeader: { flexDirection: 'row' as const, alignItems: 'center' as const, justifyContent: 'space-between' as const, paddingHorizontal: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border, gap: 8 },
    asideHeaderCollapsed: { justifyContent: 'center' as const, paddingHorizontal: 0 },
    asideTitleBox: { flex: 1, minWidth: 0 },
    asideTitle: { color: colors.foreground, fontSize: 14, fontWeight: '600' as const },
    asideSubtitle: { color: colors.foregroundMuted, fontSize: 11, marginTop: 1 },
    asideList: { paddingVertical: 8, gap: 10 },
    group: { gap: 1 },
    groupLabel: { color: colors.foregroundMuted, fontSize: 11, fontWeight: '600' as const, letterSpacing: 0.4, textTransform: 'uppercase' as const, paddingHorizontal: 14, paddingBottom: 4 },
    groupRule: { height: 1, backgroundColor: colors.border, marginHorizontal: 12, marginBottom: 4 },
    item: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 10, marginHorizontal: 6, paddingHorizontal: 8, paddingVertical: 7, borderRadius: 7 },
    itemCollapsed: { justifyContent: 'center' as const, paddingHorizontal: 0 },
    itemOn: { backgroundColor: colors.surface2 },
    itemHover: { backgroundColor: colors.surface2 },
    itemBar: { position: 'absolute' as const, left: -6, top: 6, bottom: 6, width: 3, borderRadius: 2, backgroundColor: colors.accent },
    itemLabel: { flex: 1, color: colors.foreground, fontSize: 13 },
    itemLabelOn: { color: colors.foreground, fontWeight: '600' as const },
    count: { color: colors.foregroundMuted, fontSize: 11, fontVariant: ['tabular-nums' as const] },
    children: { marginLeft: 22, borderLeftWidth: 1, borderLeftColor: colors.border, marginVertical: 2, paddingLeft: 4 },
    child: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 8, marginRight: 6, paddingHorizontal: 8, paddingVertical: 5, borderRadius: 6 },
    childOn: { backgroundColor: colors.surface2 },
    childLabel: { flex: 1, color: colors.foreground, fontSize: 12.5 },
    childHint: { color: colors.foregroundMuted, fontSize: 11 },
    dot: { width: 6, height: 6, borderRadius: 3 },
    main: { flex: 1, minWidth: 0 },
    header: { borderBottomWidth: 1, borderBottomColor: colors.border, paddingHorizontal: 20, paddingTop: 14, gap: 10 },
    headerRow: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 10, minHeight: 32 },
    crumbs: { flex: 1, minWidth: 0, flexDirection: 'row' as const, alignItems: 'center' as const, gap: 8, flexWrap: 'wrap' as const },
    crumb: { color: colors.foregroundMuted, fontSize: 13 },
    crumbSeparator: { color: colors.foregroundMuted, fontSize: 13, opacity: 0.6 },
    crumbCurrent: { color: colors.foreground, fontSize: 16, fontWeight: '600' as const },
    actions: { flexDirection: 'row' as const, gap: 8, alignItems: 'center' as const },
    tabs: { flexDirection: 'row' as const, gap: 4 },
    tab: { paddingHorizontal: 10, paddingVertical: 8, borderBottomWidth: 2, borderBottomColor: 'transparent' },
    tabOn: { borderBottomColor: colors.accent },
    tabText: { color: colors.foregroundMuted, fontSize: 13 },
    tabTextOn: { color: colors.foreground, fontSize: 13, fontWeight: '600' as const },
    tabCount: { color: colors.foregroundMuted, fontSize: 11 },
    body: { flex: 1 },
    bodyContent: { padding: 20, gap: 16 },
    footer: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 10, paddingHorizontal: 20, paddingVertical: 12, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.surface1 },
    iconButton: { padding: 6, borderRadius: 6 },
    overlay: { position: 'absolute' as const, left: 0, top: 0, right: 0, bottom: 0, flexDirection: 'row' as const },
    scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.25)' },
  };
}
