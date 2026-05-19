import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { DrawnSection } from './types';

interface RefinePanelProps {
  isActivelyDrawing: boolean;
  drawnSections: DrawnSection[];
  optimizing: boolean;
  insets: { bottom: number };
  
  // Callbacks
  onStartDrawing: () => void;
  onStopDrawing: () => void;
  onUndoSection: () => void;
  onApplySections: () => void;
  onExitRefineMode: () => void;
}

export const RefinePanel: React.FC<RefinePanelProps> = ({
  isActivelyDrawing,
  drawnSections,
  optimizing,
  insets,
  onStartDrawing,
  onStopDrawing,
  onUndoSection,
  onApplySections,
  onExitRefineMode,
}) => {
  return (
    <View style={[styles.floatingRefinePanel, { bottom: insets.bottom + 16 }]} data-testid="refine-mode-controls">
      {isActivelyDrawing ? (
        <View style={styles.drawingStatusBar} data-testid="drawing-status-bar">
          <View style={styles.drawingPulse} />
          <Text style={styles.drawingStatusText}>Draw around stops to group them</Text>
          <TouchableOpacity 
            style={styles.cancelDrawingBtn}
            onPress={onStopDrawing}
            data-testid="cancel-drawing-btn"
          >
            <Ionicons name="close-circle" size={24} color="#ef4444" />
          </TouchableOpacity>
        </View>
      ) : (
        <>
          {/* Section Summary */}
          {drawnSections.length > 0 && (
            <View style={styles.sectionSummary} data-testid="section-summary">
              {drawnSections.map((section) => (
                <View key={section.id} style={[styles.sectionPill, { backgroundColor: section.color + '40' }]}>
                  <View style={[styles.sectionPillDot, { backgroundColor: section.color }]} />
                  <Text style={[styles.sectionPillText, { color: section.color }]}>
                    Group {section.id}: {section.stopIds.length} stops
                  </Text>
                </View>
              ))}
            </View>
          )}
          
          {/* Action Buttons Row */}
          <View style={styles.refineActionRow}>
            <TouchableOpacity 
              style={[styles.refineActionBtn, drawnSections.length === 0 && styles.refineActionBtnDisabled]}
              onPress={onUndoSection}
              disabled={drawnSections.length === 0}
              data-testid="undo-section-btn"
            >
              <Ionicons name="arrow-undo" size={20} color={drawnSections.length > 0 ? "#fff" : "#94a3b8"} />
              <Text style={[styles.refineActionBtnText, drawnSections.length === 0 && styles.refineActionBtnTextDisabled]}>Undo</Text>
            </TouchableOpacity>
            
            <TouchableOpacity 
              style={styles.drawNextGroupBtn}
              onPress={onStartDrawing}
              data-testid="draw-next-group-btn"
            >
              <Ionicons name="brush" size={20} color="#fff" />
              <Text style={styles.drawNextGroupBtnText}>Draw group</Text>
            </TouchableOpacity>
            
            <TouchableOpacity 
              style={[styles.reoptimizeBtn, drawnSections.length === 0 && styles.reoptimizeBtnDisabled]}
              onPress={onApplySections}
              disabled={drawnSections.length === 0 || optimizing}
              data-testid="reoptimize-route-btn"
            >
              {optimizing ? (
                <ActivityIndicator size="small" color="white" />
              ) : (
                <>
                  <Ionicons name="refresh" size={18} color="white" />
                  <Text style={styles.reoptimizeBtnText}>Reoptimize</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
          
          {/* Exit Button */}
          <TouchableOpacity 
            style={styles.exitRefineBtn}
            onPress={onExitRefineMode}
            data-testid="exit-refine-mode-btn"
          >
            <Ionicons name="close" size={16} color="rgba(255,255,255,0.7)" />
            <Text style={styles.exitRefineBtnText}>Exit drawing mode</Text>
          </TouchableOpacity>
        </>
      )}
    </View>
  );
};

// Floating Entry Button Component
interface RefineEntryButtonProps {
  insets: { bottom: number };
  onPress: () => void;
}

export const RefineEntryButton: React.FC<RefineEntryButtonProps> = ({
  insets,
  onPress,
}) => {
  return (
    <TouchableOpacity
      style={[styles.floatingRefineEntryBtn, { bottom: insets.bottom + 16 }]}
      onPress={onPress}
      activeOpacity={0.85}
      data-testid="refine-route-btn"
    >
      <Ionicons name="pencil" size={18} color="#fff" />
      <Text style={styles.floatingRefineEntryBtnText}>Refine Route</Text>
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  floatingRefinePanel: {
    position: 'absolute',
    left: 16,
    right: 16,
    backgroundColor: 'rgba(15, 23, 42, 0.92)',
    borderRadius: 20,
    padding: 16,
    zIndex: 20,
    elevation: 10,
  },
  drawingStatusBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(254, 243, 199, 0.15)',
    padding: 12,
    borderRadius: 12,
  },
  drawingPulse: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: '#fbbf24',
  },
  drawingStatusText: {
    flex: 1,
    fontSize: 14,
    fontWeight: '600',
    color: '#fbbf24',
    marginLeft: 10,
  },
  cancelDrawingBtn: {
    padding: 4,
  },
  sectionSummary: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginBottom: 12,
  },
  sectionPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 20,
    marginRight: 8,
    marginBottom: 6,
  },
  sectionPillDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  sectionPillText: {
    fontSize: 12,
    fontWeight: '600',
  },
  refineActionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  refineActionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
  },
  refineActionBtnDisabled: {
    opacity: 0.5,
  },
  refineActionBtnText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#e2e8f0',
    marginLeft: 6,
  },
  refineActionBtnTextDisabled: {
    color: '#94a3b8',
  },
  drawNextGroupBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 10,
    backgroundColor: 'rgba(139, 92, 246, 0.3)',
    borderWidth: 1,
    borderColor: '#8b5cf6',
  },
  drawNextGroupBtnText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#c4b5fd',
    marginLeft: 8,
  },
  reoptimizeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 10,
    backgroundColor: '#3b82f6',
  },
  reoptimizeBtnDisabled: {
    backgroundColor: '#93c5fd',
  },
  reoptimizeBtnText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#fff',
    marginLeft: 6,
  },
  exitRefineBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.1)',
    marginTop: 4,
  },
  exitRefineBtnText: {
    fontSize: 13,
    fontWeight: '500',
    color: 'rgba(255, 255, 255, 0.6)',
    marginLeft: 6,
  },
  floatingRefineEntryBtn: {
    position: 'absolute',
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#8b5cf6',
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderRadius: 25,
    elevation: 8,
    zIndex: 15,
  },
  floatingRefineEntryBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
    marginLeft: 8,
  },
});

export default RefinePanel;
