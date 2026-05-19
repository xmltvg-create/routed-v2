// Shared types for route components
import { Stop } from '../../store/stopsStore';

export type ViewMode = 'planning' | 'navigating';

export interface NavigationLeg {
  from_stop: Stop | null;
  to_stop: Stop | null;
  distance: number;
  duration: number;
  summary: string;
  steps: any[];
}

export interface NavigationData {
  total_distance: number;
  total_duration: number;
  geometry: any;
  legs: NavigationLeg[];
  stops: Stop[];
}

export interface LiveRoute {
  distance: number;
  duration: number;
  geometry: any;
  steps: any[];
}

export interface OptimizationHub {
  id: string;
  latitude: number;
  longitude: number;
  order: number;
  address?: string;
}

export interface DrawnSection {
  id: number;
  stopIds: string[];
  color: string;
}

export interface Algorithm {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: 'fast' | 'quality' | 'ai';
}

// Utility functions
export const formatDistance = (meters: number): string => {
  if (meters >= 10000) {
    return `${Math.round(meters / 1000)} km`;
  }
  if (meters >= 1000) {
    const km = Math.round(meters / 500) * 0.5;
    return Number.isInteger(km) ? `${km} km` : `${km} km`;
  }
  if (meters >= 500) {
    return `${Math.round(meters / 100) * 100} m`;
  }
  return `${Math.max(50, Math.round(meters / 50) * 50)} m`;
};

export const formatDuration = (seconds: number): string => {
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (hours > 0) {
    return `${hours}h ${mins}m`;
  }
  return `${mins} min`;
};

export const getManeuverIcon = (type?: string, modifier?: string): string => {
  if (!type) return 'arrow-up';
  
  const iconMap: { [key: string]: string } = {
    'turn-right': 'arrow-forward',
    'turn-left': 'arrow-back',
    'turn-sharp-right': 'return-down-forward',
    'turn-sharp-left': 'return-down-back',
    'turn-slight-right': 'arrow-forward',
    'turn-slight-left': 'arrow-back',
    'uturn': 'return-up-back',
    'roundabout': 'sync',
    'rotary': 'sync',
    'merge': 'git-merge',
    'fork': 'git-branch',
    'arrive': 'flag',
    'depart': 'navigate',
  };
  
  return iconMap[type] || iconMap[`${type}-${modifier}`] || 'arrow-up';
};

export const SECTION_COLORS = [
  '#ef4444', '#f97316', '#f59e0b', '#84cc16', 
  '#22c55e', '#14b8a6', '#06b6d4', '#3b82f6', 
  '#6366f1', '#8b5cf6', '#a855f7', '#ec4899'
];
