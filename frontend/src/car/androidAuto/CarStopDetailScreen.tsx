import React from 'react';
import { View, Text } from 'react-native';

export const CarStopDetailScreen = (props: any) => {
  const stop = props?.route?.params?.stop;

  if (!stop) {
    return (
      <View>
        <Text>No stop data</Text>
      </View>
    );
  }

  return (
    <View>
      <Text>{stop.name || 'Stop Details'}</Text>
      <Text>{stop.address || 'Unknown address'}</Text>
    </View>
  );
};
