import { Stop } from '../store/stopsStore';

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
  polygon: { lat: number; lng: number }[];
}
