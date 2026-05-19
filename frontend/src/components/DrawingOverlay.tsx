import React, { useRef, useMemo, useState, useEffect } from 'react';
import { View, StyleSheet, PanResponder } from 'react-native';
import Svg, { Path, Circle } from 'react-native-svg';

interface Point {
  x: number;
  y: number;
}

interface DrawingOverlayProps {
  isActive: boolean;
  onDrawComplete: (points: Point[]) => void;
  onDrawUpdate?: (points: Point[]) => void;
  style?: any;
}

export const DrawingOverlay: React.FC<DrawingOverlayProps> = ({
  isActive,
  onDrawComplete,
  style,
}) => {
  const pathRef = useRef<Point[]>([]);
  const isActiveRef = useRef(isActive);
  const [currentPath, setCurrentPath] = useState<Point[]>([]);
  const [completedPath, setCompletedPath] = useState<Point[]>([]);
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  isActiveRef.current = isActive;

  // Clear completed path when drawing mode changes
  useEffect(() => {
    if (isActive) {
      setCompletedPath([]);
    }
    return () => {
      if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
    };
  }, [isActive]);

  // Convert points array to smooth SVG path using quadratic Bezier curves
  const getPathString = (points: Point[], closed: boolean = true): string => {
    if (points.length < 2) return '';
    
    // For very few points, use simple lines
    if (points.length < 4) {
      let d = `M ${points[0].x} ${points[0].y}`;
      for (let i = 1; i < points.length; i++) {
        d += ` L ${points[i].x} ${points[i].y}`;
      }
      if (closed) d += ' Z';
      return d;
    }
    
    // Use smooth quadratic Bezier curves for freehand feel
    let d = `M ${points[0].x} ${points[0].y}`;
    
    for (let i = 1; i < points.length - 1; i++) {
      const prev = points[i - 1];
      const curr = points[i];
      const next = points[i + 1];
      
      // Control point is the current point
      // End point is midway between current and next
      const endX = (curr.x + next.x) / 2;
      const endY = (curr.y + next.y) / 2;
      
      d += ` Q ${curr.x} ${curr.y} ${endX} ${endY}`;
    }
    
    // Connect to the last point
    const lastPoint = points[points.length - 1];
    d += ` L ${lastPoint.x} ${lastPoint.y}`;
    
    // Smooth close back to start
    if (closed && points.length > 3) {
      const firstMid = {
        x: (points[0].x + points[1].x) / 2,
        y: (points[0].y + points[1].y) / 2
      };
      d += ` Q ${points[0].x} ${points[0].y} ${firstMid.x} ${firstMid.y}`;
      d += ' Z';
    } else if (closed) {
      d += ' Z';
    }
    
    return d;
  };

  const panResponder = useMemo(() =>
    PanResponder.create({
      onStartShouldSetPanResponder: () => isActiveRef.current,
      onMoveShouldSetPanResponder: () => isActiveRef.current,
      onPanResponderGrant: (evt) => {
        if (!isActiveRef.current) return;
        // Clear any previous completed path
        setCompletedPath([]);
        if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
        const { locationX, locationY } = evt.nativeEvent;
        pathRef.current = [{ x: locationX, y: locationY }];
        setCurrentPath([{ x: locationX, y: locationY }]);
      },
      onPanResponderMove: (evt) => {
        if (!isActiveRef.current) return;
        const { locationX, locationY } = evt.nativeEvent;
        pathRef.current.push({ x: locationX, y: locationY });
        // Update more frequently for smoother curves
        if (pathRef.current.length % 2 === 0) {
          setCurrentPath([...pathRef.current]);
        }
      },
      onPanResponderRelease: () => {
        if (!isActiveRef.current) return;
        const allPoints = [...pathRef.current];
        if (allPoints.length > 5) {
          // Show the final complete polygon briefly before it gets replaced by map layer
          setCurrentPath([]);
          setCompletedPath(allPoints);
          onDrawComplete(allPoints);
          // Keep the completed polygon visible for a moment, then fade
          fadeTimerRef.current = setTimeout(() => {
            setCompletedPath([]);
          }, 800);
        } else {
          setCurrentPath([]);
        }
        pathRef.current = [];
      },
      onPanResponderTerminate: () => {
        pathRef.current = [];
        setCurrentPath([]);
      },
    }),
  [onDrawComplete]);

  // Use active drawing path or the completed polygon
  const displayPath = currentPath.length > 0 ? currentPath : completedPath;
  const hasContent = displayPath.length > 0;

  // Always render but only intercept touches when active
  if (!isActive && !hasContent) {
    return null;
  }

  return (
    <View
      style={[styles.overlay, style, !isActive && styles.overlayPassthrough]}
      {...(isActive ? panResponder.panHandlers : {})}
      pointerEvents={isActive ? 'auto' : 'none'}
      data-testid="drawing-overlay"
    >
      <Svg style={styles.svg}>
        {/* Smooth filled polygon */}
        {displayPath.length > 2 && (
          <Path
            d={getPathString(displayPath, true)}
            fill="rgba(139, 92, 246, 0.2)"
            stroke="#8b5cf6"
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
        {/* Initial line (exactly 2 points) */}
        {displayPath.length === 2 && (
          <Path
            d={`M ${displayPath[0].x} ${displayPath[0].y} L ${displayPath[1].x} ${displayPath[1].y}`}
            fill="none"
            stroke="#8b5cf6"
            strokeWidth={2.5}
            strokeLinecap="round"
          />
        )}
        {/* Starting point indicator */}
        {displayPath.length > 0 && (
          <Circle
            cx={displayPath[0].x}
            cy={displayPath[0].y}
            r={8}
            fill="#8b5cf6"
            stroke="#fff"
            strokeWidth={2}
          />
        )}
      </Svg>
    </View>
  );
};

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 9999,
    backgroundColor: 'transparent',
  },
  overlayPassthrough: {
    zIndex: 0,
  },
  svg: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
});
