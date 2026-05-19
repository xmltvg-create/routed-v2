import React from 'react';
import { View, Text } from 'react-native';
import { CarMainScreen } from './CarMainScreen';
import { CarStopDetailScreen } from './CarStopDetailScreen';

export const AndroidAutoRoot = () => {
  return (
    <View>
      <Text>Android Auto runtime is disabled in this build.</Text>
      <CarMainScreen />
      <CarStopDetailScreen route={{ params: {} }} />
    </View>
  );
};
